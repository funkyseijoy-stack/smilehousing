import type { Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";
import { getAccessToken } from "../lib/google.mts";
import { listCollection } from "../lib/booking.mts";

// Gmail で「タスク」ラベル（LABEL_NAME）を付けたメールを、15分おきに社内タスク（担当者なし・未着手）にする定期関数。
// 1つのスレッド（メールのやりとり）につき1件だけ作る（タスクIDは task_gm_<スレッドID> で固定。削除したタスクも作り直さない）。
// Gmail の権限は読み取り＋下書きだけなので、ラベルは外さない（外さなくても二重には作らない）。
// 定期実行の関数は、Netlify が本番デプロイに対してのみ実行する。

const LABEL_NAME = "タスク";
const LOOKBACK = "newer_than:30d";
const MAX_THREADS = 20;
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

export default async () => {
  const tok = await getAccessToken();
  if (!tok.ok) { console.error("gmail-label-tasks: token", tok); return; }
  const auth = { Authorization: "Bearer " + (tok as any).accessToken };
  const g = async (path: string) => {
    const r = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/" + path, { headers: auth });
    if (!r.ok) throw new Error("gmail " + r.status + " " + path);
    return r.json();
  };

  const q = `label:${LABEL_NAME} ${LOOKBACK}`;
  const list: any = await g("threads?maxResults=" + MAX_THREADS + "&q=" + encodeURIComponent(q));
  const threads: any[] = list.threads || [];
  if (!threads.length) return;

  const store = getStore("staffData");
  const photoStore = getStore("customerPhotos");
  const vendors = await listCollection(store, "vendors").catch(() => []);
  let projects: any[] | null = null;

  for (const th of threads) {
    const taskId = "task_gm_" + th.id;
    const exists = await store.get(`tasks/${taskId}`, { type: "json", consistency: "strong" }).catch(() => null);
    if (exists) continue;
    try {
      const full: any = await g("threads/" + th.id + "?format=full");
      const msgs: any[] = full.messages || [];
      if (!msgs.length) continue;
      // ラベルが付いたメッセージのうち、自分が送ったもの（SENT）以外のいちばん新しいもの。無ければ最後のメッセージ
      const labelled = msgs.filter((m) => !(m.labelIds || []).includes("SENT"));
      const msg = labelled[labelled.length - 1] || msgs[msgs.length - 1];
      const headers = msg.payload?.headers || [];
      const subject = hv(headers, "Subject") || "（件名なし）";
      const from = hv(headers, "From");
      const fromName = nameOf(from);
      const fromMail = emailOf(from);
      const date = msg.internalDate ? new Date(Number(msg.internalDate)).toISOString() : new Date().toISOString();
      const body = plainText(msg.payload).slice(0, 1500);

      // 送り主が業者一覧の人なら業者名で表示
      const v = vendors.find((x: any) => x && x.email && String(x.email).toLowerCase().split(/[,\s;]+/).includes(fromMail));
      const who = v ? v.name : fromName;

      // 件名・本文にお客様名・案件名が1つだけ出てくれば、その案件にする
      if (!projects) projects = await listCollection(store, "projects").catch(() => []);
      const hay = norm(subject + "\n" + body);
      const hits = (projects || []).filter((p: any) => !p.finishedAt && !p.demo && [p.customer, p.name].some((n: any) => {
        const k = norm(n); return k.length >= 2 && hay.includes(k);
      }));
      const projectId = hits.length === 1 ? hits[0].id : "";

      // 添付（自分が送ったメール以外。小さな画像＝署名のロゴなどは除く）
      const files: any[] = [];
      const parts: any[] = [];
      walk(msg.payload, (p) => { if (p.filename && p.body?.attachmentId) parts.push(p); });
      for (const p of parts) {
        if (files.length >= MAX_FILES) break;
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

      const now = new Date().toISOString();
      const d = new Date(Date.parse(date) + 9 * 3600 * 1000);
      const when = `${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
      await store.setJSON(`tasks/${taskId}`, {
        id: taskId, projectId,
        content: `【メール】${subject}（${who}・${when}）` + (body ? "\n" + body : ""),
        assignee: "", instructor: "", creator: "Gmail",
        hasDeadline: false, deadline: "", requestTo: "", requestMethod: "",
        attachmentAssetIds: [], attachments: files, vendorSpec: null, private: false,
        reflected: false, reflectedAt: null, status: "未着手",
        fromGmail: { threadId: th.id, messageId: msg.id, from, subject, date },
        createdAt: now, updatedAt: now,
      });
    } catch (e) {
      console.error("gmail-label-tasks: thread", th.id, e);
    }
  }
};

export const config: Config = {
  schedule: "*/15 * * * *",
};
