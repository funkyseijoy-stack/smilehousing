import { createSign } from "node:crypto";

// LINE WORKS（API 2.0）のBotから、スタッフへ個人宛のメッセージを送る。
// 接続情報は Netlify の環境変数に入れる（コードには書かない）：
//   WORKS_CLIENT_ID / WORKS_CLIENT_SECRET / WORKS_SERVICE_ACCOUNT / WORKS_PRIVATE_KEY（PEM。改行は \n でもよい）/ WORKS_BOT_ID
// どれかが無いときは「未設定」として何も送らない（呼び出し側がメールに切り替える）。
// 失敗しても例外は投げず false を返す。

function env(name: string): string {
  try { return (Netlify.env.get(name) || "").trim(); } catch { return ""; }
}
export function worksConfigured(): boolean {
  return !!(env("WORKS_CLIENT_ID") && env("WORKS_CLIENT_SECRET") && env("WORKS_SERVICE_ACCOUNT") && env("WORKS_PRIVATE_KEY") && env("WORKS_BOT_ID"));
}

const b64url = (b: Buffer | string) => Buffer.from(b).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

// 秘密鍵（PEM）を読める形に直す。Netlifyの入力欄に貼ると改行が空白になったり、\n の文字になったりするため、
// 先頭・末尾の行を除いた本文だけを取り出して64文字ごとに改行し直す。
export function normalizePem(raw: string): string {
  const t = String(raw || "").replace(/\\n/g, "\n").replace(/\r/g, "").trim().replace(/^["']|["']$/g, "");
  const m = t.match(/-----BEGIN ([A-Z ]+)-----([\s\S]*?)-----END \1-----/);
  const label = m ? m[1] : "PRIVATE KEY";
  const body = (m ? m[2] : t).replace(/\s+/g, "");
  return "-----BEGIN " + label + "-----\n" + (body.match(/.{1,64}/g) || []).join("\n") + "\n-----END " + label + "-----\n";
}

let cached: { token: string; exp: number } | null = null;

async function getWorksToken(): Promise<string> {
  if (cached && cached.exp > Date.now() + 60_000) return cached.token;
  const now = Math.floor(Date.now() / 1000);
  const head = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claim = b64url(JSON.stringify({ iss: env("WORKS_CLIENT_ID"), sub: env("WORKS_SERVICE_ACCOUNT"), iat: now, exp: now + 3600 }));
  const signer = createSign("RSA-SHA256");
  signer.update(head + "." + claim);
  const sig = b64url(signer.sign(normalizePem(env("WORKS_PRIVATE_KEY"))));
  const res = await fetch("https://auth.worksmobile.com/oauth2/v2.0/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      assertion: head + "." + claim + "." + sig,
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      client_id: env("WORKS_CLIENT_ID"),
      client_secret: env("WORKS_CLIENT_SECRET"),
      scope: "bot",
    }),
  });
  const j: any = await res.json().catch(() => ({}));
  if (!res.ok || !j.access_token) throw new Error("works_token_failed:" + res.status);
  cached = { token: j.access_token, exp: Date.now() + (Number(j.expires_in) || 3600) * 1000 };
  return cached.token;
}

// userId へ個人宛のテキストを送る（本文は2000文字まで）。送れたら true。
export async function sendWorksDM(userId: string, text: string): Promise<boolean> {
  try {
    if (!worksConfigured() || !userId) { console.error("works_not_ready", { configured: worksConfigured(), hasUser: !!userId }); return false; }
    const token = await getWorksToken();
    const res = await fetch(
      "https://www.worksapis.com/v1.0/bots/" + encodeURIComponent(env("WORKS_BOT_ID")) + "/users/" + encodeURIComponent(userId) + "/messages",
      {
        method: "POST",
        headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
        body: JSON.stringify({ content: { type: "text", text: String(text).slice(0, 1900) } }),
      }
    );
    if (res.status === 401) cached = null; // 次回はトークンを取り直す
    if (!res.ok) console.error("works_send_failed", res.status, (await res.text().catch(() => "")).slice(0, 300));
    return res.ok;
  } catch (e: any) {
    console.error("works_send_error", String(e && e.message || e).slice(0, 300));
    return false;
  }
}
