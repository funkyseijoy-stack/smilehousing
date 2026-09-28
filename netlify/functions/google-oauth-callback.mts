import type { Context, Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";

function htmlPage(title: string, message: string) {
  return `<!doctype html><html lang="ja"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
body{font-family:-apple-system,BlinkMacSystemFont,"Hiragino Sans","Yu Gothic",sans-serif;
background:#faf7f2;color:#333;display:flex;align-items:center;justify-content:center;
min-height:100vh;margin:0;padding:24px;text-align:center;}
.card{background:#fff;border-radius:16px;padding:32px 24px;max-width:420px;
box-shadow:0 4px 20px rgba(0,0,0,.08);}
h1{font-size:18px;margin:0 0 12px;color:#3f7d5c;}
p{font-size:15px;line-height:1.6;margin:0;}
</style></head>
<body><div class="card"><h1>${title}</h1><p>${message}</p></div></body></html>`;
}

// GoogleのOAuth同意画面から戻ってきたときに呼ばれる。
// 受け取った認可コードをトークンに交換し、リフレッシュトークンを保存する。
export default async (req: Request, context: Context) => {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const error = url.searchParams.get("error");

  if (error) {
    return new Response(
      htmlPage("連携できませんでした", "Google側でキャンセルされたか、エラーが発生しました。このタブを閉じてもう一度お試しください。(" + error + ")"),
      { status: 400, headers: { "Content-Type": "text/html; charset=utf-8" } }
    );
  }
  if (!code) {
    return new Response(htmlPage("エラー", "認可コードが見つかりませんでした。"), {
      status: 400,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }

  const clientId = Netlify.env.get("GOOGLE_CLIENT_ID");
  const clientSecret = Netlify.env.get("GOOGLE_CLIENT_SECRET");
  const redirectUri = Netlify.env.get("GOOGLE_REDIRECT_URI");
  if (!clientId || !clientSecret || !redirectUri) {
    return new Response(htmlPage("エラー", "サーバー側の設定が不足しています。"), {
      status: 500,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }

  try {
    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        grant_type: "authorization_code",
      }),
    });
    const tokenData: any = await tokenRes.json();

    if (!tokenRes.ok || !tokenData.refresh_token) {
      // すでに一度許可済みで refresh_token が返らないケース。
      // その場合は既存の保存値を維持する。
      if (tokenRes.ok && tokenData.access_token) {
        return new Response(
          htmlPage(
            "確認",
            "接続は確認できましたが、新しい許可情報は発行されませんでした。既存の連携をそのままお使いいただけます。問題があれば管理者にご連絡ください。このタブは閉じて大丈夫です。"
          ),
          { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } }
        );
      }
      return new Response(
        htmlPage("連携できませんでした", "トークンの取得に失敗しました。もう一度お試しください。" + JSON.stringify(tokenData)),
        { status: 400, headers: { "Content-Type": "text/html; charset=utf-8" } }
      );
    }

    const store = getStore("googleAuth");
    await store.setJSON("gmail", {
      refresh_token: tokenData.refresh_token,
      scope: tokenData.scope || "",
      connectedAt: new Date().toISOString(),
    });

    return new Response(
      htmlPage("連携が完了しました", "Gmailとの連携が完了しました。このタブを閉じて、アプリに戻ってください。"),
      { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } }
    );
  } catch (e: any) {
    return new Response(htmlPage("エラー", "予期しないエラーが発生しました。" + (e?.message || "")), {
      status: 500,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }
};

export const config: Config = {
  path: "/api/google-oauth-callback",
};
