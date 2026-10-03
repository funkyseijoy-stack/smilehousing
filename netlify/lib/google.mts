import { getStore } from "@netlify/blobs";

// Google API 共通処理（アクセストークン取得・通知メール送信）。
// 保存済みのリフレッシュトークン（googleAuth ストアの "gmail"）を使う。
// カレンダーを使うには、住まいるアプリの Google 連携をカレンダー権限つきでやり直す必要がある。

export const NOTIFY_TO = "smilehousing8@gmail.com";
// 「お客様予約」カレンダー（smilehousing8@gmail.com で共有されているカレンダー）
export const CUSTOMER_CALENDAR_ID =
  "e6267bdeb2588554b92706493bd7805585d8693153647800912b396fc8525dc5@group.calendar.google.com";
export const HOLIDAY_CALENDAR_ID = "ja.japanese#holiday@group.v.calendar.google.com";

export async function getAccessToken(): Promise<
  { ok: true; accessToken: string; scope: string } | { ok: false; error: string }
> {
  const clientId = Netlify.env.get("GOOGLE_CLIENT_ID");
  const clientSecret = Netlify.env.get("GOOGLE_CLIENT_SECRET");
  if (!clientId || !clientSecret) return { ok: false, error: "server_not_configured" };
  const store = getStore("googleAuth");
  const data: any = await store.get("gmail", { type: "json" });
  if (!data || !data.refresh_token) return { ok: false, error: "google_not_connected" };
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: data.refresh_token,
      grant_type: "refresh_token",
    }),
  });
  const tokenData: any = await res.json();
  if (!res.ok || !tokenData.access_token) return { ok: false, error: "refresh_failed" };
  return { ok: true, accessToken: tokenData.access_token, scope: String(data.scope || "") };
}

function mimeHeader(text: string) {
  if (/^[\x00-\x7F]*$/.test(text)) return text;
  return "=?UTF-8?B?" + Buffer.from(text, "utf-8").toString("base64") + "?=";
}

// スタッフへの通知メールを送る。失敗しても呼び出し元の処理は止めない（true/false を返すだけ）。
export async function sendNotifyMail(subject: string, body: string): Promise<boolean> {
  try {
    const t = await getAccessToken();
    if (!t.ok) return false;
    const lines = [
      "To: " + NOTIFY_TO,
      "Subject: " + mimeHeader(subject),
      "MIME-Version: 1.0",
      'Content-Type: text/plain; charset="UTF-8"',
      "Content-Transfer-Encoding: base64",
      "",
      Buffer.from(body, "utf-8").toString("base64").replace(/(.{76})/g, "$1\r\n"),
    ];
    const raw = Buffer.from(lines.join("\r\n"), "utf-8")
      .toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const res = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
      method: "POST",
      headers: { Authorization: "Bearer " + t.accessToken, "Content-Type": "application/json" },
      body: JSON.stringify({ raw }),
    });
    return res.ok;
  } catch {
    return false;
  }
}
