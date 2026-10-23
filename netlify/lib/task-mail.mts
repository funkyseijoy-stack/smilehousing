import { sendMailTo } from "./google.mts";
import { nowJst } from "./booking.mts";
import { sendWorksDM, worksConfigured } from "./lineworks.mts";

// タスクの担当者・確認者へ、個人のメールで知らせる。
// 宛先は 設定（settings/main）の staffEmails（名前 → メールアドレス）。登録がない人には送らない。
export const APP_URL = "https://sprightly-pegasus-9b65a7.netlify.app/app/";
const FROM_NAME = "住まいるアプリ";

export async function staffEmailOf(store: any, name: string): Promise<string> {
  if (!name) return "";
  const s: any = await store.get("settings/main", { type: "json" });
  const m = s && s.staffEmails;
  const v = m && typeof m[name] === "string" ? m[name].trim() : "";
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) ? v : "";
}

// スタッフの LINE WORKS ユーザーID（設定 settings/main の staffWorksIds：名前 → ID）
export async function staffWorksIdOf(store: any, name: string): Promise<string> {
  if (!name) return "";
  const s: any = await store.get("settings/main", { type: "json" });
  const m = s && s.staffWorksIds;
  const v = m && typeof m[name] === "string" ? m[name].trim() : "";
  return /^\S+$/.test(v) ? v : "";
}

// タスクの通知を1人に送る。LINE WORKS の接続情報とその人のユーザーIDがあれば LINE WORKS だけ。
// 未設定の人・送れなかったときは、これまでどおりメールで送る（通知が届かなくなるのを防ぐ）。
const MAIL_FOOTER = "（このメールは住まいるアプリから自動で送っています）";
async function notifyStaff(store: any, name: string, subject: string, body: string): Promise<boolean> {
  if (worksConfigured()) {
    const wid = await staffWorksIdOf(store, name);
    console.log("works_notify", { name, hasWorksId: !!wid });
    if (wid) {
      const text = subject + "\n\n" + body.replace(MAIL_FOOTER, "（住まいるアプリからの自動通知です）");
      if (await sendWorksDM(wid, text)) return true;
    }
  }
  const to = await staffEmailOf(store, name);
  console.log("works_fallback_mail", { name, hasEmail: !!to, worksConfigured: worksConfigured() });
  if (!to) return false;
  return (await sendMailTo({ to, subject, body, fromName: FROM_NAME })).ok;
}

// ---- ともこ（朋子）には、タスクの通知をすべて「控え」として自動で送る ----
// 「自分だけ」のタスクは通知の対象外（従来どおり）。本人が操作した分（by）は送らない。
export const ALL_NOTICE_NAME = "朋子";
function copyBodyFor(body: string): string {
  const i = body.indexOf("\n");
  return ALL_NOTICE_NAME + "さん（すべてのタスク通知の控えです）" + (i >= 0 ? body.slice(i) : "");
}
async function notifyAdminCopy(store: any, by: string, toName: string, subject: string, body: string): Promise<boolean> {
  if (by === ALL_NOTICE_NAME || toName === ALL_NOTICE_NAME) return false;
  return await notifyStaff(store, ALL_NOTICE_NAME, "【控え】" + subject, copyBodyFor(body));
}

function taskLines(t: any, projectName: string): string[] {
  const lines = [
    "案件：" + (projectName || "（案件未設定）"),
    "内容：" + String(t.content || "").slice(0, 300),
  ];
  if (t.hasDeadline && t.deadline) lines.push("期限：" + t.deadline);
  if (t.vendorSpec && t.vendorSpec.label) lines.push("部位：" + t.vendorSpec.label);
  if (t.memo) lines.push("メモ：" + String(t.memo).slice(0, 300));
  return lines;
}

// role: "assignee"（担当者になった）／"checker"（確認を頼まれた）
export async function sendTaskAssignedMail(store: any, task: any, role: "assignee" | "checker", name: string, by: string) {
  let projectName = "";
  if (task.projectId) {
    const p: any = await store.get("projects/" + task.projectId, { type: "json" });
    projectName = (p && p.name) || "";
  }
  const head = role === "checker" ? "確認のお願いが届きました" : "タスクの担当になりました";
  const subject = "【住まいる】" + head + "：" + String(task.content || "").replace(/\s+/g, " ").slice(0, 30);
  const body = [
    name + "さん",
    "",
    (by ? by + "さんから、" : "") + (role === "checker" ? "確認のお願いが届きました。" : "あなたが担当のタスクが追加されました。"),
    "",
    ...taskLines(task, projectName),
    "",
    "▼ 住まいるアプリを開く",
    APP_URL,
    "",
    "（このメールは住まいるアプリから自動で送っています）",
  ].join("\n");
  const ok = await notifyStaff(store, name, subject, body);
  await notifyAdminCopy(store, by, name, subject, body).catch(() => false);
  return ok;
}

export async function sendDeadlineDigest(store: any, name: string, when: "today" | "tomorrow", items: { task: any; projectName: string; role: string }[]) {
  if (!items.length) return false;
  const label = when === "today" ? "今日" : "明日";
  const subject = "【住まいる】" + label + "が期限のタスクが" + items.length + "件あります";
  const body = [
    name + "さん",
    "",
    label + "が期限のタスクです。",
    "",
    ...items.map((x, i) => (i + 1) + ". " + taskLines(x.task, x.projectName).join("\n   ") + (x.role === "checker" ? "\n   （確認のお願い）" : x.role === "admin" ? "\n   （担当：" + (x.task.assignee || "未設定") + (x.task.checker ? "／確認：" + x.task.checker : "") + "）" : "")),
    "",
    "▼ 住まいるアプリを開く",
    APP_URL,
    "",
    "（このメールは住まいるアプリから自動で送っています）",
  ].join("\n");
  return await notifyStaff(store, name, subject, body);
}

// ---- 夜（18:00〜翌9:00 日本時間）に入ったタスクは、翌朝9時にまとめて通知する ----
export function isQuietHourJst(): boolean {
  const h = Math.floor(nowJst().min / 60);
  return h >= 18 || h < 9;
}
const QUEUE_PREFIX = "notifyQueue/";
export async function queueTaskNotice(store: any, task: any, role: "assignee" | "checker", name: string, by: string) {
  const key = QUEUE_PREFIX + task.id + "__" + role + "__" + encodeURIComponent(name);
  await store.setJSON(key, { taskId: task.id, role, name, by, queuedAt: new Date().toISOString() });
  // ともこへの控え（夜のあいだは、翌朝のまとめ通知に入れる）
  if (name !== ALL_NOTICE_NAME && by !== ALL_NOTICE_NAME) {
    const k2 = QUEUE_PREFIX + task.id + "__admin" + role + "__" + encodeURIComponent(name);
    await store.setJSON(k2, { taskId: task.id, role: "admin", forRole: role, forName: name, name: ALL_NOTICE_NAME, by, queuedAt: new Date().toISOString() });
  }
}

// 翌朝の定期実行から呼ぶ。たまっていた通知を、人ごとに1通へまとめて送る。
export async function flushTaskQueue(store: any) {
  const { blobs } = await store.list({ prefix: QUEUE_PREFIX });
  const entries: any[] = [];
  for (const b of blobs) {
    const q: any = await store.get(b.key, { type: "json" });
    entries.push({ key: b.key, q });
  }
  const groups = new Map<string, { key: string; task: any; role: string }[]>();
  const dead: string[] = [];
  for (const { key, q } of entries) {
    if (!q) { dead.push(key); continue; }
    const t: any = await store.get("tasks/" + q.taskId, { type: "json" });
    const stillMine = t && !t.deletedAt && !t.private && (t.status || "") !== "完了" &&
      (q.role === "admin" ? true : q.role === "checker" ? (t.checker === q.name || t.status === q.name + "確認依頼中" || t.status === q.name + "確認中") : t.assignee === q.name);
    if (!stillMine) { dead.push(key); continue; }
    if (!groups.has(q.name)) groups.set(q.name, []);
    groups.get(q.name)!.push({ key, task: t, role: q.role, forName: q.forName, forRole: q.forRole } as any);
  }
  for (const [name, list] of groups) {
    const items: string[] = [];
    for (let i = 0; i < list.length; i++) {
      const t = list[i].task;
      let projectName = "";
      if (t.projectId) { const p: any = await store.get("projects/" + t.projectId, { type: "json" }); projectName = (p && p.name) || ""; }
      const li: any = list[i];
      const label = li.role === "admin" ? "【控え：" + (li.forName || "") + "さんが" + (li.forRole === "checker" ? "確認" : "担当") + "】" : li.role === "checker" ? "【確認のお願い】" : "【担当】";
      items.push((i + 1) + ". " + label + "\n   " + taskLines(t, projectName).join("\n   "));
    }
    const body = [name + "さん", "", "昨日の夕方以降に届いたタスクをまとめてお知らせします。", "", ...items, "", "▼ 住まいるアプリを開く", APP_URL, "", "（このメールは住まいるアプリから自動で送っています）"].join("\n");
    const ok = await notifyStaff(store, name, "【住まいる】夜のあいだに届いたタスクが" + list.length + "件あります", body);
    // 送り先が1つも無い人（ワークスもメールも未登録）の分は、たまり続けないよう捨てる
    const hasDest = (worksConfigured() && (await staffWorksIdOf(store, name))) || (await staffEmailOf(store, name));
    if (ok || !hasDest) dead.push(...list.map((x) => x.key));
  }
  for (const k of dead) await store.delete(k);
}

// ---- 完了の報告：完了にするとき画面で選んだ人＋ともこ（控え） ----
export async function sendTaskDoneMails(store: any, task: any, by: string) {
  const names = new Set<string>();
  if (Array.isArray(task.reportTo)) {
    for (const n of task.reportTo) { const s = String(n || "").trim(); if (s) names.add(s.slice(0, 30)); }
  } else {
    // 画面を通さずに完了になった場合（古い画面など）は、依頼者だけに知らせる
    const requester = task.instructor || task.creator || "";
    if (requester) names.add(requester);
  }
  names.add(ALL_NOTICE_NAME);
  if (by) names.delete(by);
  let projectName = "";
  if (task.projectId) { const p: any = await store.get("projects/" + task.projectId, { type: "json" }); projectName = (p && p.name) || ""; }
  const subject = "【住まいる】タスクが完了しました：" + String(task.content || "").replace(/\s+/g, " ").slice(0, 30);
  for (const name of names) {
    const body = [name + "さん", "", (by ? by + "さんが、" : "") + "次のタスクを完了にしました。", "", ...taskLines(task, projectName),
      ...(task.assignee ? ["担当：" + task.assignee] : []), "", "▼ 住まいるアプリを開く", APP_URL, "", "（このメールは住まいるアプリから自動で送っています）"].join("\n");
    await notifyStaff(store, name, subject, body);
  }
}

// ---- 確認者の承認／差し戻し：担当者（いなければ作成者・指示者）へ知らせる ----
export async function sendTaskReviewMail(store: any, task: any, by: string) {
  const r = task.review || {};
  const commented = r.result === "コメント";
  // コメントは届け先（to）へ。届け先が無いコメントは誰にも送らない
  const name = commented ? String(r.to || "") : (task.assignee || task.creator || task.instructor || "");
  if (!name) return false;
  let projectName = "";
  if (task.projectId) { const p: any = await store.get("projects/" + task.projectId, { type: "json" }); projectName = (p && p.name) || ""; }
  const approved = r.result === "承認";
  const replied = r.result === "返信";
  const subject = "【住まいる】" + (commented ? (r.back ? "コメントで戻されました" : "コメントがありました") : replied ? "返信がありました" : approved ? "承認されました" : "差し戻されました") + "：" + String(task.content || "").replace(/\s+/g, " ").slice(0, 30);
  const body = [name + "さん", "",
    (r.by || by ? (r.by || by) + "さんが、" : "") + (commented ? (r.back ? "次のタスクにコメントして、あなたへ戻しました（進捗は「対応中」）。" : "次のタスクにコメントしました。") : replied ? "次のタスクに返信しました。" : approved ? "次のタスクを承認しました。進めてください。" : "次のタスクを差し戻しました。内容を確認してください。"), "",
    ...(r.note ? [(replied ? "返信：" : "コメント：") + String(r.note).slice(0, 1000), ""] : []),
    ...taskLines(task, projectName), "", "▼ 住まいるアプリを開く", APP_URL, "", MAIL_FOOTER].join("\n");
  const ok = name !== by ? await notifyStaff(store, name, subject, body) : false;
  // ともこへの控え（承認／差し戻し／返信をしたのが本人のときは送らない）
  if ((r.by || by) !== ALL_NOTICE_NAME) await notifyAdminCopy(store, by, name, subject, body).catch(() => false);
  return ok;
}
