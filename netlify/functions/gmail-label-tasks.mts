import type { Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";
import { getAccessToken } from "../lib/google.mts";
import { listCollection } from "../lib/booking.mts";
import { sendTaskReviewMail } from "../lib/task-mail.mts";

// Gmail で「タスク」ラベル（LABEL_NAME）を付けたメール、および「メイン」に届いた人からのメール（AUTO_QUERY。
// 広告・SNS・自動送信・自分が送ったメールは除く）を、15分おきに社内タスク（担当者なし・未着手＝朋子の「割り振り待ち」）にする定期関数。
// 同じスレッドに新しい返信が届いたら、そのタスクのやりとり（reviews）に追記し、完了していれば「未着手」に戻す（seenIds で既読を管理）。
// 1つのスレッド（メールのやりとり）につき1件だけ作る（タスクIDは task_gm_<スレッドID> で固定。削除したタスクも作り直さない）。
// Gmail の権限は読み取り＋下書きだけなので、ラベルは外さない（外さなくても二重には作らない）。
// 定期実行の関数は、Netlify が本番デプロイに対してのみ実行する。

const LABEL_NAME = "タスク";
const LOOKBACK = "newer_than:30d";
const MAX_THREADS = 20;
// 人から届いたメール（ラベル不要）。メインのカテゴリーの受信箱だけ・自分が送ったものは除く
const AUTO_QUERY = "in:inbox category:primary -from:me newer_than:3d";
// 自動送信のアドレス・ヘッダーは取り込まない
const AUTO_SENDER_RE = /(no-?reply|do-?not-?reply|mailer-daemon|postmaster|notifications?@|bounce|newsletter|magazine|info-?mail@|news@|mailmag)/i;
function isAutomated(headers: any[], fromMail: string) {
  if (AUTO_SENDER_RE.test(fromMail)) return true;
  if (hv(headers, "List-Unsubscribe") || hv(headers, "List-Id")) return true;
  const auto = hv(headers, "Auto-Submitted").toLowerCase();
  if (auto && auto !== "no") return true;
  if (/^(bulk|list|junk)$/i.test(hv(headers, "Precedence").trim())) return true;
  return false;
}
const MAX_FILES = 5;
const MAX_FILE_BYTES = 15 * 1024 * 1024;
const ATTACH_SLUG = "gmail";

function hv(headers: any[], name: string) {
  const h = (headers || []).find((x: any) => (x.name || "").toLowerCase() === name.toLowerCase());
  return h ? String(h.value || "") : "";
}
function b64(s: string) {
  return Buffer.from(String(s || "").replace(/-/g, "+").replace(/_/g, "/"), "base64");
}
function walk(part: any, fn: (p: any) => void) {
  if (!part) return;
  fn(part);
  (part.parts || []).forEach((p: any) => walk(p, fn));
}
function plainText(payload: any): string {
  let plain = "", html = "";
  walk(payload, (p) => {
    if (p.filename) return;
    if (p.mimeType === "text/plain" && p.body?.data && !plain) plain = b64(p.body.data).toString("utf8");
    if (p.mimeType === "text/html" && p.body?.data && !html) html = b64(p.body.data).toString("utf8");
  });
  let t = plain || html.replace(/<br\s*\/?>/gi, "\n").replace(/<\/p>/gi, "\n").replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
  // 引用部分（> で始まる行・「〜wrote:」以降）は省く
  const lines = t.replace(/\r/g, "").split("\n");
  const out: string[] = [];
  for (const l of lines) {
    if (/^On .+wrote:$/.test(l.trim()) || /^\d{4}年\d{1,2}月\d{1,2}日.+:$/.test(l.trim())) break;
    if (/^>/.test(l)) continue;
    out.push(l);
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}
function nameOf(from: string) {
  const m = from.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>/);
  return m ? (m[1] || m[2]).trim() : from.trim();
}
function emailOf(from: string) {
  const m = from.match(/<([^>]+)>/);
  return (m ? m[1] : from).trim().toLowerCase();
}
const norm = (s: string) => String(s || "").replace(/[\s　様邸]/g, "");

// 件名か添付の名前に「見積」「定価」「プランボード」が入っていれば見積のメール（タスクの名前を【見積】にする。住まいるアプリの isQuoteMailTask と同じ判定）
const QUOTE_WORDS = /見積|定価|プランボード/;
function isQuoteMail(subject: string, files: any[]): boolean {
  return QUOTE_WORDS.test(subject || "") || (files || []).some((f: any) => QUOTE_WORDS.test(String(f?.name || "")));
}

export default async () => {
  const tok = await getAccessToken();
  if (!tok.ok) { console.error("gmail-label-tasks: token", tok); return; }
  const auth = { Authorization: "Bearer " + (tok as any).accessToken };
  const g = async (path: string) => {
    const r = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/" + path, { headers: auth });
    if (!r.ok) throw new Error("gmail " + r.status + " " + path);
    return r.json();
  };

  const listQ = async (q: string) => {
    const list: any = await g("threads?maxResults=" + MAX_THREADS + "&q=" + encodeURIComponent(q)).catch((e: any) => { console.error("gmail-label-tasks: list", q, e); return {}; });
    return (list.threads || []) as any[];
  };
  const labelled = await listQ(`label:${LABEL_NAME} ${LOOKBACK}`);
  const autoThreads = await listQ(AUTO_QUERY);
  const seenTh = new Set<string>();
  const jobs: { id: string; auto: boolean }[] = [];
  labelled.forEach((t) => { if (!seenTh.has(t.id)) { seenTh.add(t.id); jobs.push({ id: t.id, auto: false }); } });
  autoThreads.forEach((t) => { if (!seenTh.has(t.id)) { seenTh.add(t.id); jobs.push({ id: t.id, auto: true }); } });
  if (!jobs.length) return;

  const store = getStore("staffData");
  const photoStore = getStore("customerPhotos");
  const vendors = await listCollection(store, "vendors").catch(() => []);
  let projects: any[] | null = null;

  const saveFiles = async (msg: any, max: number) => {
    const files: any[] = [];
    const parts: any[] = [];
    walk(msg.payload, (p) => { if (p.filename && p.body?.attachmentId) parts.push(p); });
    for (const p of parts) {
      if (files.length >= max) break;
      const size = Number(p.body?.size || 0);
      if (size > MAX_FILE_BYTES) continue;
      if (/^image\//.test(p.mimeType || "") && size < 15000) continue;
      try {
        const att: any = await g("messages/" + msg.id + "/attachments/" + p.body.attachmentId);
        const bytes = b64(att.data);
        const key = "p" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
        const ct = p.mimeType || "application/octet-stream";
        await photoStore.set(`${ATTACH_SLUG}/${key}`, bytes, { metadata: { contentType: ct } });
        files.push({ id: `${ATTACH_SLUG}/${key}`, url: `/api/get-photo?slug=${ATTACH_SLUG}&key=${encodeURIComponent(key)}`, contentType: ct, name: p.filename });
      } catch (e) { console.error("gmail-label-tasks: attachment", e); }
    }
    return files;
  };
  const whoOf = (from: string) => {
    const fromMail = emailOf(from);
    const v = vendors.find((x: any) => x && x.email && String(x.email).toLowerCase().split(/[,\s;]+/).includes(fromMail));
    return v ? v.name : nameOf(from);
  };
  const mdOf = (iso: string) => { const d = new Date(Date.parse(iso) + 9 * 3600 * 1000); return `${d.getUTCMonth() + 1}/${d.getUTCDate()}`; };

  for (const job of jobs) {
    const taskId = "task_gm_" + job.id;
    try {
      const existing: any = await store.get(`tasks/${taskId}`, { type: "json", consistency: "strong" }).catch(() => null);
      if (existing && existing.deletedAt) continue; // 削除したタスクは作り直さない・追記もしない
      if (existing && !existing.fromGmail) continue;
      const full: any = await g("threads/" + job.id + "?format=full");
      const msgs: any[] = full.messages || [];
      if (!msgs.length) continue;
      const incoming = msgs.filter((m) => !(m.labelIds || []).includes("SENT"));

      if (existing) {
        // 新しい返信をやりとりに追記する（以前のタスクで seenIds が無いときは、いまのメールを既読にするだけ）
        const fg = existing.fromGmail;
        if (!Array.isArray(fg.seenIds)) {
          fg.seenIds = msgs.map((m) => m.id);
          await store.setJSON(`tasks/${taskId}`, existing);
          continue;
        }
        const seen = new Set<string>(fg.seenIds);
        const before = seen.size;
        const fresh = incoming.filter((m) => !seen.has(m.id) && !isAutomated(m.payload?.headers || [], emailOf(hv(m.payload?.headers || [], "From"))));
        msgs.forEach((m) => seen.add(m.id));
        fg.seenIds = Array.from(seen).slice(-200);
        if (!fresh.length) { if (seen.size !== before) await store.setJSON(`tasks/${taskId}`, existing); continue; }
        const now = new Date().toISOString();
        existing.reviews = Array.isArray(existing.reviews) ? existing.reviews : (existing.review ? [existing.review] : []);
        for (const m of fresh) {
          const from = hv(m.payload?.headers || [], "From");
          const date = m.internalDate ? new Date(Number(m.internalDate)).toISOString() : now;
          const body = plainText(m.payload).slice(0, 1500);
          const files = await saveFiles(m, MAX_FILES);
          if (files.length) existing.attachments = (existing.attachments || []).concat(files);
          const rv = { result: "コメント", by: "✉️ " + whoOf(from), to: existing.assignee || "", note: `【メールの返信】${mdOf(date)}\n${body}` + (files.length ? `\n（添付 ${files.length}件をタスクに付けました）` : ""), at: now };
          existing.reviews.push(rv);
          existing.review = rv;
        }
        if (existing.status === "完了") { existing.status = "未着手"; existing.archivedAt = null; existing.completedAt = null; }
        existing.updatedAt = now;
        await store.setJSON(`tasks/${taskId}`, existing);
        if (existing.assignee && !existing.private) await sendTaskReviewMail(store, existing, "Gmail").catch(() => false);
        continue;
      }

      // 新しいタスク：ラベル付き・人からのメールのうち、自分が送ったもの以外のいちばん新しいもの
      const cand = job.auto ? incoming.filter((m) => !isAutomated(m.payload?.headers || [], emailOf(hv(m.payload?.headers || [], "From")))) : incoming;
      if (job.auto && !cand.length) continue;
      const msg = cand[cand.length - 1] || msgs[msgs.length - 1];
      const headers = msg.payload?.headers || [];
      const subject = hv(headers, "Subject") || "（件名なし）";
      const from = hv(headers, "From");
      const date = msg.internalDate ? new Date(Number(msg.internalDate)).toISOString() : new Date().toISOString();
      const body = plainText(msg.payload).slice(0, 1500);
      const who = whoOf(from);

      // 件名・本文にお客様名・案件名が1つだけ出てくれば、その案件にする
      if (!projects) projects = await listCollection(store, "projects").catch(() => []);
      const hay = norm(subject + "\n" + body);
      const hits = (projects || []).filter((p: any) => !p.finishedAt && !p.demo && [p.customer, p.name].some((n: any) => {
        const k = norm(n); return k.length >= 2 && hay.includes(k);
      }));
      const projectId = hits.length === 1 ? hits[0].id : "";
      const files = await saveFiles(msg, MAX_FILES);

      const now = new Date().toISOString();
      await store.setJSON(`tasks/${taskId}`, {
        id: taskId, projectId,
        content: `${isQuoteMail(subject, files) ? "【見積】" : "【メール】"}${subject}（${who}・${mdOf(date)}）` + (body ? "\n" + body : ""),
        assignee: "", instructor: "", creator: "Gmail",
        hasDeadline: false, deadline: "", requestTo: "", requestMethod: "",
        attachmentAssetIds: [], attachments: files, vendorSpec: null, private: false,
        reflected: false, reflectedAt: null, status: "未着手",
        fromGmail: { threadId: job.id, messageId: msg.id, from, subject, date, auto: job.auto, seenIds: msgs.map((m) => m.id) },
        createdAt: now, updatedAt: now,
      });
    } catch (e) {
      console.error("gmail-label-tasks: thread", job.id, e);
    }
  }
};

export const config: Config = {
  schedule: "*/15 * * * *",
};
