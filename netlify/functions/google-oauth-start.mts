import type { Context, Config } from "@netlify/functions";

// staff-auth.mts と同じ値にしてください。
const STAFF_PASSPHRASE = "sumairu2026";

// Gmailの下書き作成・送信（通知メール） ＋ 受信箱の閲覧 ＋ カレンダー予定の読み書き（お客様予約）に必要なスコープ
const SCOPE = "https://www.googleapis.com/auth/gmail.compose https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/calendar.events";

// 最初の一回だけ、社内の代表Gmailアカウント(smilehousing8@gmail.com)でログインして
// このアプリにGmail下書き作成の許可を与えるための入口。
// ブラウザで直接開くURLなので、ヘッダーではなくクエリの ?token= でチェックする。
export default async (req: Request, context: Context) => {
  const url = new URL(req.url);
  const token = url.searchParams.get("token") || "";
  if (token !== STAFF_PASSPHRASE) {
    return new Response("合言葉が違います。アプリ内のリンクから開き直してください。", {
      status: 401,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }

  const clientId = Netlify.env.get("GOOGLE_CLIENT_ID");
  const redirectUri = Netlify.env.get("GOOGLE_REDIRECT_URI");
  if (!clientId || !redirectUri) {
    return new Response("サーバー側の設定(GOOGLE_CLIENT_ID / GOOGLE_REDIRECT_URI)が未設定です。", {
      status: 500,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }

  const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  authUrl.searchParams.set("client_id", clientId);
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("scope", SCOPE);
  authUrl.searchParams.set("access_type", "offline");
  authUrl.searchParams.set("prompt", "consent"); // 毎回リフレッシュトークンを確実に受け取るため
  authUrl.searchParams.set("include_granted_scopes", "true");

  return new Response(null, {
    status: 302,
    headers: { Location: authUrl.toString() },
  });
};

export const config: Config = {
  path: "/api/google-oauth-start",
};
