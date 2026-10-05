import { CUSTOMER_MAIL_SIGNATURE } from "./google.mts";
import { WD, dowOf } from "./booking.mts";

// 新規のお客様向け予約（/yoyaku/）で送るメールの文面。
// 予約直後の「確認メール」と、前日の「リマインド」を同じ形式で作る。
// 差出人は共有Gmail（住まいるハウジング）。お客様が返信すると、そのGmailに届く。
// スタッフが手動で送る「日時変更・キャンセル・自由なメッセージ」の文面の雛形は、住まいるアプリ側（public/app/index.html）にある。

export type PublicBooking = {
  customerName?: string; email?: string; date: string; startTime: string; endTime: string;
  type?: string; notes?: string;
};

export function dateTimeLabel(r: { date: string; startTime: string; endTime: string }) {
  const [, m, d] = r.date.split("-").map(Number);
  return `${m}月${d}日（${WD[dowOf(r.date)]}） ${r.startTime}〜${r.endTime}`;
}

export function confirmationMail(r: PublicBooking): { subject: string; body: string } {
  const type = r.type || "ショールーム見学＆おうち相談";
  return {
    subject: `【住まいるハウジング】${type}のご予約を承りました`,
    body:
      `${r.customerName || "お客"}様\n\n` +
      `このたびは、ご予約いただきありがとうございます。\n` +
      `下記の内容で承りました。\n\n` +
      `■ ご予約内容\n` +
      `種類：${type}\n` +
      `日時：${dateTimeLabel(r)}（所要時間 約2時間）\n` +
      (r.notes ? `ご相談内容：${r.notes}\n` : "") +
      `\n当日は、お気をつけてお越しください。\n` +
      `ご予約の変更・キャンセルをご希望の場合や、ご不明な点がございましたら、このメールにご返信ください。\n` +
      `※数分たっても届かない場合は、迷惑メールフォルダもご確認ください。\n` +
      CUSTOMER_MAIL_SIGNATURE,
  };
}

export function reminderMail(r: PublicBooking): { subject: string; body: string } {
  const type = r.type || "ショールーム見学＆おうち相談";
  return {
    subject: `【住まいるハウジング】明日のご予約のご案内（${type}）`,
    body:
      `${r.customerName || "お客"}様\n\n` +
      `いつもお世話になっております。住まいるハウジングです。\n` +
      `明日、下記のご予約をいただいております。\n\n` +
      `■ ご予約内容\n` +
      `種類：${type}\n` +
      `日時：${dateTimeLabel(r)}（所要時間 約2時間）\n\n` +
      `ご都合が悪くなった場合や、日時を変更されたい場合は、このメールにご返信ください。\n` +
      `お会いできるのを楽しみにしております。\n` +
      CUSTOMER_MAIL_SIGNATURE,
  };
}
