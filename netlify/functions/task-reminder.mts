import type { Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";
import { nowJst, addDays, listCollection } from "../lib/booking.mts";
import { sendDeadlineDigest } from "../lib/task-mail.mts";

// 期限の「前日」と「当日」の朝（9:00 日本時間）に、担当者・確認者へ個人のメールでリマインドする。
// 完了したタスク・削除したタスク・「自分だけ」のタスクは対象外。メールアドレスが未登録の人には送らない。
// 定期実行の関数は、Netlify が本番デプロイに対してのみ実行する。
export default async () => {
  const store = getStore("staffData");
  const today = nowJst().date;
  const tomorrow = addDays(today, 1);
  const tasks = (await listCollection(store, "tasks")).filter((t: any) =>
    !t.private && t.hasDeadline && (t.deadline === today || t.deadline === tomorrow) && (t.status || "未着手") !== "完了");
  if (!tasks.length) return;
  const projects = new Map<string, string>();
  for (const p of await listCollection(store, "projects")) projects.set((p as any).id, (p as any).name || "");
  // 人ごと・日ごとにまとめる（担当者と確認者の両方に送る）
  const groups = new Map<string, { name: string; when: "today" | "tomorrow"; items: any[] }>();
  for (const t of tasks) {
    const when = t.deadline === today ? "today" : "tomorrow";
    const people: [string, string][] = [];
    if (t.assignee) people.push([t.assignee, "assignee"]);
    if (t.checker && t.checker !== t.assignee) people.push([t.checker, "checker"]);
    for (const [name, role] of people) {
      const k = name + "|" + when;
      if (!groups.has(k)) groups.set(k, { name, when, items: [] });
      groups.get(k)!.items.push({ task: t, projectName: projects.get(t.projectId) || "", role });
    }
  }
  for (const g of groups.values()) {
    await sendDeadlineDigest(store, g.name, g.when, g.items);
  }
};

export const config: Config = {
  // 毎日 00:00 UTC = 9:00 JST
  schedule: "0 0 * * *",
};
