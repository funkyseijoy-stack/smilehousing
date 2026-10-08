import { sendMailTo } from "./google.mts";
import { nowJst } from "./booking.mts";

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
  const to = await staffEmailOf(store, name);
  if (!to) return false;
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
  return (await sendMailTo({ to, subject, body, fromName: FROM_NAME })).ok;
}

export async function sendDeadlineDigest(store: any, name: string, when: "today" | "tomorrow", items: { task: any; projectName: string; role: string }[]) {
  const to = await staffEmailOf(store, name);
  if (!to || !items.length) return false;
  const label = when === "today" ? "今日" : "明日";
  const subject = "【住まいる】" + label + "が期限のタスクが" + items.length + "件あります";
  const body = [
    name + "さん",
    "",
    label + "が期限のタスクです。",
    "",
    ...items.map((x, i) => (i + 1) + ". " + taskLines(x.task, x.projectName).join("\n   ") + (x.role === "checker" ? "\n   （確認のお願い）" : "")),
    "",
    "▼ 住まいるアプリを開く",
    APP_URL,
    "",
    "（このメールは住まいるアプリから自動で送っています）",
  ].join("\n");
  return (await sendMailTo({ to, subject, body, fromName: FROM_NAME })).ok;
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
      (q.role === "checker" ? (t.checker === q.name || t.status === q.name + "確認中") : t.assignee === q.name);
    if (!stillMine) { dead.push(key); continue; }
    if (!groups.has(q.name)) groups.set(q.name, []);
    groups.get(q.name)!.push({ key, task: t, role: q.role });
  }
  for (const [name, list] of groups) {
    const to = await staffEmailOf(store, name);
    if (!to) { dead.push(...list.map((x) => x.key)); continue; }
    const items: string[] = [];
    for (let i = 0; i < list.length; i++) {
      const t = list[i].task;
      let projectName = "";
      if (t.projectId) { const p: any = await store.get("projects/" + t.projectId, { type: "json" }); projectName = (p && p.name) || ""; }
      items.push((i + 1) + ". " + (list[i].role === "checker" ? "【確認のお願い】" : "【担当】") + "\n   " + taskLines(t, projectName).join("\n   "));
    }
    const body = [name + "さん", "", "昨日の夕方以降に届いたタスクをまとめてお知らせします。", "", ...items, "", "▼ 住まいるアプリを開く", APP_URL, "", "（このメールは住まいるアプリから自動で送っています）"].join("\n");
    const ok = (await sendMailTo({ to, subject: "【住まいる】夜のあいだに届いたタスクが" + list.length + "件あります", body, fromName: FROM_NAME })).ok;
    if (ok) dead.push(...list.map((x) => x.key));
  }
  for (const k of dead) await store.delete(k);
}

// ---- 完了の報告：社長・朋子・依頼者（指示者。いなければ作成者）へ ----
export const DONE_REPORT_TO = ["社長", "朋子"];
export async function sendTaskDoneMails(store: any, task: any, by: string) {
  const names = new Set<string>(DONE_REPORT_TO);
  const requester = task.instructor || task.creator || "";
  if (requester) names.add(requester);
  if (by) names.delete(by);
  let projectName = "";
  if (task.projectId) { const p: any = await store.get("projects/" + task.projectId, { type: "json" }); projectName = (p && p.name) || ""; }
  const subject = "【住まいる】タスクが完了しました：" + String(task.content || "").replace(/\s+/g, " ").slice(0, 30);
  for (const name of names) {
    const to = await staffEmailOf(store, name);
    if (!to) continue;
    const body = [name + "さん", "", (by ? by + "さんが、" : "") + "次のタスクを完了にしました。", "", ...taskLines(task, projectName),
      ...(task.assignee ? ["担当：" + task.assignee] : []), "", "▼ 住まいるアプリを開く", APP_URL, "", "（このメールは住まいるアプリから自動で送っています）"].join("\n");
    await sendMailTo({ to, subject, body, fromName: FROM_NAME });
  }
}
