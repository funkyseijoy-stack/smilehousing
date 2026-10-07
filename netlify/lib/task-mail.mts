import { sendMailTo } from "./google.mts";

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
