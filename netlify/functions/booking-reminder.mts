import type { Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";
import { sendMailTo, sendNotifyMail, CUSTOMER_MAIL_FROM_NAME } from "../lib/google.mts";
import { reminderMail } from "../lib/customer-mail.mts";
import { nowJst, addDays, listCollection } from "../lib/booking.mts";

// 新規のお客様向け予約（source:"public"）の「前日リマインド」メール。毎朝 9:00（日本時間）に実行する。
// 明日の予約で、メールアドレスがあり、まだリマインドを送っていないものに送る。
// 予約から12時間以内のものは、確認メールを送ったばかりなので送らない。
// 送れなかったものは、スタッフへ通知メールでお知らせする（お電話などで連絡できるように）。
// 定期実行の関数は、Netlify が本番デプロイに対してのみ実行する。

export default async () => {
  const store = getStore("staffData");
  const tomorrow = addDays(nowJst().date, 1);
  const resvs = await listCollection(store, "reservations");
  const targets = resvs.filter((r: any) =>
    r.source === "public" && r.date === tomorrow && r.email && !r.reminderSentAt &&
    Date.now() - Date.parse(r.createdAt || "") > 12 * 3600 * 1000);
  const failed: string[] = [];
  for (const r of targets) {
    const m = reminderMail(r);
    const sent = await sendMailTo({ to: r.email, subject: m.subject, body: m.body, fromName: CUSTOMER_MAIL_FROM_NAME });
    if (sent.ok) {
      await store.setJSON(`reservations/${r.id}`, { ...r, reminderSentAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    } else {
      failed.push(`${r.customerName || ""}様 ${r.date} ${r.startTime}（${r.phone || ""}／${r.email}）`);
    }
  }
  if (failed.length) {
    await sendNotifyMail("【要確認】前日リマインドメールを送れなかった予約があります",
      "明日の予約のうち、リマインドメールを送れなかったものがあります。お電話などでご連絡ください。\n\n" + failed.join("\n"));
  }
};

export const config: Config = {
  // 毎日 00:00 UTC = 9:00 JST
  schedule: "0 0 * * *",
};
