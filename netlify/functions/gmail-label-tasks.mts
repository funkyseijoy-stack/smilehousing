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

// ---- ダウンロードのリンクで届くメール（TOTOなど）・パスワードの別メール ----
// 添付が無く、本文にダウンロードのリンクがあるメールは、タスクに downloads=[{who,from,links,at,pw}] を付ける（画面に「🔗 要ダウンロード」）。
// 同じ送り主から前後2日以内に届いた「パスワード」のメールは、新しいタスクにせず、そのリンクのタスクの pw に追記する。
const DL_WORDS = /ダウンロード|download|ファイル便|宅ファイル|ギガファイル|gigafile|firestorage|dropbox|box\.com|datadeliver|sharepoint|onedrive|wetransfer|クリプト便|eTransfer/i;
const PW_RE = /パスワード|password|ﾊﾟｽﾜｰﾄﾞ/i;
const PUBLIC_DOMAINS = ["gmail.com","googlemail.com","icloud.com","me.com","mac.com","outlook.jp","outlook.com","hotmail.com","hotmail.co.jp","live.jp","live.com","msn.com","yahoo.co.jp","yahoo.com","ymail.com","docomo.ne.jp","ezweb.ne.jp","au.com","softbank.ne.jp","i.softbank.jp","nifty.com","ocn.ne.jp","biglobe.ne.jp","so-net.ne.jp","plala.or.jp"];
function rawHtml(payload: any): string {
  let html = "";
  walk(payload, (p) => { if (!p.filename && p.mimeType === "text/html" && p.body?.data && !html) html = b64(p.body.data).toString("utf8"); });
  return html;
}
function linksOf(payload: any, text: string): string[] {
  const urls: string[] = [];
  const add = (u: string) => { u = u.replace(/&amp;/g, "&").replace(/[)）」』>\]。、,.]+$/, ""); if (/^https?:\/\//.test(u) && !urls.includes(u)) urls.push(u); };
  (String(text || "").match(/https?:\/\/[^\s"'<>　]+/g) || []).forEach(add);
  const html = rawHtml(payload);
  (html.match(/href\s*=\s*["']([^"']+)["']/gi) || []).forEach((h) => { const m = h.match(/["']([^"']+)["']/); if (m) add(m[1]); });
  const dl = urls.filter((u) => DL_WORDS.test(u));
  return (dl.length ? dl : urls).filter((u) => !/unsubscribe|mailto:|\.(png|jpe?g|gif)(\?|$)/i.test(u)).slice(0, 3);
}
function isDownloadMail(subject: string, body: string, links: string[]): boolean {
  return links.length > 0 && DL_WORDS.test(subject + "\n" + body);
}
function isPasswordMail(subject: string, body: string): boolean {
  return PW_RE.test(subject + "\n" + body.slice(0, 600));
}
function pwSnippet(body: string): string {
  const lines = String(body || "").split("\n").map((l) => l.trim()).filter(Boolean);
  const i = lines.findIndex((l) => PW_RE.test(l));
  return (i >= 0 ? lines.slice(i, i + 3) : lines.slice(0, 3)).join("\n").slice(0, 300);
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
  // 送り主の業者：登録アドレスの完全一致 → 無ければ同じ会社のドメイン（個人向けドメインは除く・そのドメインの業者が1社だけのとき）
  const vendorsOf = (fromMail: string): any[] => {
    const exact = vendors.filter((x: any) => x && x.email && String(x.email).toLowerCase().split(/[,\s;]+/).includes(fromMail));
    if (exact.length) return exact;
    const dom = fromMail.split("@")[1] || "";
    if (!dom || PUBLIC_DOMAINS.includes(dom)) return [];
    const byDom = vendors.filter((x: any) => x && x.email && String(x.email).toLowerCase().split(/[,\s;]+/).some((e: string) => e.split("@")[1] === dom));
    return byDom.length === 1 ? byDom : [];
  };
  let tasksCache: any[] | null = null, reqsCache: any[] | null = null;
  const allTasks = async () => { if (!tasksCache) tasksCache = await listCollection(store, "tasks").catch(() => []); return tasksCache as any[]; };
  const allReqs = async () => { if (!reqsCache) reqsCache = await listCollection(store, "requests").catch(() => []); return reqsCache as any[]; };
  // 見積依頼のタスク（estReq）で、この業者の分がまだ届いていないもの。1件に決まるときだけ返す
  const findEstTarget = async (fromMail: string, projectId: string) => {
    const vs = vendorsOf(fromMail); if (!vs.length) return null;
    const vids = vs.map((v: any) => v.id);
    const reqs = await allReqs();
    const cands: { task: any; req: any }[] = [];
    for (const t of await allTasks()) {
      if (!t || t.deletedAt || !t.estReq || (t.status || "") === "完了") continue;
      const r = reqs.find((x: any) => (t.estReq.reqIds || []).includes(x.id) && vids.includes(x.vendorId) && x.status !== "受領済み" && !x.estClosed);
      if (r) cands.push({ task: t, req: r });
    }
    const pick = projectId ? cands.filter((c) => c.req.projectId === projectId) : cands;
    if (pick.length === 1) return pick[0];
    if (!projectId && cands.length === 1) return cands[0];
    return null;
  };
  // リンクのタスク（downloads）で、同じ送り主・前後2日・パスワードがまだ無いもの
  const findDlTarget = async (fromMail: string, date: string) => {
    const at = Date.parse(date) || Date.now();
    for (const t of await allTasks()) {
      if (!t || t.deletedAt || !Array.isArray(t.downloads)) continue;
      const d = t.downloads.find((x: any) => x && x.from === fromMail && !x.pw && Math.abs((Date.parse(x.at) || 0) - at) <= 2 * 86400000);
      if (d) return { task: t, dl: d };
    }
    return null;
  };
  // 先に届いていたパスワードだけのタスク（同じ送り主・前後2日）
  const findPwTask = async (fromMail: string, date: string) => {
    const at = Date.parse(date) || Date.now();
    return (await allTasks()).find((t: any) => t && !t.deletedAt && t.pwOnly && t.pwOnly.from === fromMail && (t.status || "") !== "完了" && Math.abs((Date.parse(t.pwOnly.at) || 0) - at) <= 2 * 86400000) || null;
  };
  const saveTask = async (t: any) => {
    await store.setJSON(`tasks/${t.id}`, t);
    if (tasksCache) { const i = tasksCache.findIndex((x: any) => x.id === t.id); if (i >= 0) tasksCache[i] = t; else tasksCache.push(t); }
  };
  // 届いたメールを、見積依頼のタスク（target）に追記する。依頼は「返信あり」にする
  const mergeIntoEst = async (target: any, req: any, m: any, files: any[], links: string[], threadId: string) => {
    const headers = m.payload?.headers || [];
    const from = hv(headers, "From"), subject = hv(headers, "Subject") || "（件名なし）";
    const now = new Date().toISOString();
    const date = m.internalDate ? new Date(Number(m.internalDate)).toISOString() : now;
    const body = plainText(m.payload).slice(0, 1500);
    const v = vendors.find((x: any) => x.id === req.vendorId);
    const vname = (v && v.name) || whoOf(from);
    if (files.length) target.attachments = (target.attachments || []).concat(files.map((f) => ({ ...f, fromVendorId: req.vendorId })));
    if (isDownloadMail(subject, body, links)) {
      target.downloads = (target.downloads || []).concat([{ who: vname, from: emailOf(from), links, at: date, subject }]);
    }
    target.reviews = Array.isArray(target.reviews) ? target.reviews : (target.review ? [target.review] : []);
    const rv = { result: "コメント", by: "✉️ " + vname, to: target.assignee || "", note: `【メールが届きました】${mdOf(date)}　${subject}\n${body}` + (files.length ? `\n（添付 ${files.length}件をこのカードに付けました）` : ""), at: now };
    target.reviews.push(rv); target.review = rv;
    target.updatedAt = now;
    await saveTask(target);
    if (req.status === "依頼済み" || req.status === "未依頼") {
      const fresh: any = await store.get(`requests/${req.id}`, { type: "json", consistency: "strong" }).catch(() => null);
      if (fresh && !fresh.deletedAt && fresh.status !== "受領済み") {
        fresh.replyDetected = true; fresh.replyThreadId = threadId; fresh.replySubject = subject; fresh.replyDate = date; fresh.replySnippet = body.slice(0, 120);
        await store.setJSON(`requests/${req.id}`, fresh);
      }
    }
    if (target.assignee && !target.private) await sendTaskReviewMail(store, target, "Gmail").catch(() => false);
  };

  for (const job of jobs) {
    const taskId = "task_gm_" + job.id;
    try {
      const existing: any = await store.get(`tasks/${taskId}`, { type: "json", consistency: "strong" }).catch(() => null);
      if (existing && existing.deletedAt && !existing.mergedInto) continue; // 削除したタスクは作り直さない・追記もしない
      if (existing && !existing.fromGmail) continue;
      const full: any = await g("threads/" + job.id + "?format=full");
      const msgs: any[] = full.messages || [];
      if (!msgs.length) continue;
      const incoming = msgs.filter((m) => !(m.labelIds || []).includes("SENT"));

      if (existing && existing.mergedInto) {
        // 見積依頼のタスク・リンクのタスクにまとめたスレッド：新しい返信はまとめ先に追記する
        const fg = existing.fromGmail;
        const seen = new Set<string>(fg.seenIds || []);
        const fresh = incoming.filter((m) => !seen.has(m.id) && !isAutomated(m.payload?.headers || [], emailOf(hv(m.payload?.headers || [], "From"))));
        msgs.forEach((m) => seen.add(m.id));
        fg.seenIds = Array.from(seen).slice(-200);
        await store.setJSON(`tasks/${taskId}`, existing);
        if (!fresh.length) continue;
        const target: any = await store.get(`tasks/${existing.mergedInto}`, { type: "json", consistency: "strong" }).catch(() => null);
        if (!target || target.deletedAt) continue;
        const reqs = await allReqs();
        for (const m of fresh) {
          const fm = emailOf(hv(m.payload?.headers || [], "From"));
          const vids = vendorsOf(fm).map((v: any) => v.id);
          const req = target.estReq ? reqs.find((x: any) => (target.estReq.reqIds || []).includes(x.id) && vids.includes(x.vendorId)) : null;
          const files = await saveFiles(m, MAX_FILES);
          const body = plainText(m.payload).slice(0, 1500);
          const links = files.length ? [] : linksOf(m.payload, body);
          if (req) await mergeIntoEst(target, req, m, files, links, job.id);
          else {
            const now = new Date().toISOString();
            const date = m.internalDate ? new Date(Number(m.internalDate)).toISOString() : now;
            if (files.length) target.attachments = (target.attachments || []).concat(files);
            target.reviews = Array.isArray(target.reviews) ? target.reviews : (target.review ? [target.review] : []);
            const rv = { result: "コメント", by: "✉️ " + whoOf(hv(m.payload?.headers || [], "From")), to: target.assignee || "", note: `【メールの返信】${mdOf(date)}\n${body}`, at: now };
            target.reviews.push(rv); target.review = rv; target.updatedAt = now;
            await saveTask(target);
            if (target.assignee && !target.private) await sendTaskReviewMail(store, target, "Gmail").catch(() => false);
          }
        }
        continue;
      }
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
      const fromMail = emailOf(from);
      const links = files.length ? [] : linksOf(msg.payload, body);
      const isDl = !files.length && isDownloadMail(subject, body, links);
      const isPw = !files.length && !isDl && isPasswordMail(subject, body);
      const stub = (into: string) => ({ id: taskId, deletedAt: new Date().toISOString(), mergedInto: into,
        fromGmail: { threadId: job.id, messageId: msg.id, from, subject, date, auto: job.auto, seenIds: msgs.map((m) => m.id) } });

      // パスワードの別メール → 先に届いたリンクのタスクに追記する
      if (isPw) {
        const hit = await findDlTarget(fromMail, date);
        if (hit) {
          const now = new Date().toISOString();
          hit.dl.pw = pwSnippet(body); hit.dl.pwAt = date;
          const t = hit.task;
          t.reviews = Array.isArray(t.reviews) ? t.reviews : (t.review ? [t.review] : []);
          const rv = { result: "コメント", by: "✉️ " + who, to: t.assignee || "", note: `【パスワードのメール】${mdOf(date)}　${subject}\n${hit.dl.pw}`, at: now };
          t.reviews.push(rv); t.review = rv; t.updatedAt = now;
          await saveTask(t);
          await store.setJSON(`tasks/${taskId}`, stub(t.id));
          if (t.assignee && !t.private) await sendTaskReviewMail(store, t, "Gmail").catch(() => false);
          continue;
        }
      }
      // 見積依頼のタスクがある業者からのメール → そのカードにまとめる（新しいタスクは作らない）
      if (!isPw) {
        const est = await findEstTarget(fromMail, projectId);
        if (est) {
          await mergeIntoEst(est.task, est.req, msg, files, links, job.id);
          await store.setJSON(`tasks/${taskId}`, stub(est.task.id));
          continue;
        }
      }
      // リンクのメールで、先にパスワードだけのタスクができていたら、パスワードを引き取ってそのタスクは消す
      let pwFromTask = "";
      if (isDl) {
        const pt: any = await findPwTask(fromMail, date);
        if (pt) {
          pwFromTask = pt.pwOnly.pw || "";
          pt.deletedAt = new Date().toISOString(); pt.mergedInto = taskId;
          await saveTask(pt);
        }
      }

      const now = new Date().toISOString();
      await saveTask({
        id: taskId, projectId,
        content: `${isQuoteMail(subject, files) ? "【見積】" : "【メール】"}${subject}（${who}・${mdOf(date)}）` + (body ? "\n" + body : ""),
        assignee: "", instructor: "", creator: "Gmail",
        hasDeadline: false, deadline: "", requestTo: "", requestMethod: "",
        attachmentAssetIds: [], attachments: files, vendorSpec: null, private: false,
        reflected: false, reflectedAt: null, status: "未着手",
        fromGmail: { threadId: job.id, messageId: msg.id, from, subject, date, auto: job.auto, seenIds: msgs.map((m) => m.id) },
        ...(isDl ? { downloads: [{ who, from: fromMail, links, at: date, subject, ...(pwFromTask ? { pw: pwFromTask, pwAt: date } : {}) }] } : {}),
        ...(isPw ? { pwOnly: { from: fromMail, at: date, pw: pwSnippet(body) } } : {}),
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
