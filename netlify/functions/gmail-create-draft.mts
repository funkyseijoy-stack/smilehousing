import type { Context, Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Staff-Token",
};

// staff-auth.mts と同じ値にしてください。
const STAFF_PASSPHRASE = "sumairu2026";

function jsonResponse(obj: any, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

// 件名など、日本語を含むヘッダーをMIMEエンコードする（RFC2047, Base64形式）
function encodeMimeHeader(text: string) {
  if (!text) return "";
  // ASCIIのみならそのまま
  if (/^[\x00-\x7F]*$/.test(text)) return text;
  const b64 = Buffer.from(text, "utf-8").toString("base64");
  return "=?UTF-8?B?" + b64 + "?=";
}

// base64文字列を、メール本文として正しい76文字改行に整形する
function wrapBase64(b64: string) {
  return b64.replace(/(.{76})/g, "$1\r\n");
}

function base64ToBase64Url(b64: string) {
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

type Attachment = { filename: string; mimeType: string; content: string };

function buildMimeMessage(opts: {
  to: string[];
  subject: string;
  body: string;
  attachments: Attachment[];
}) {
  const boundary = "smlHsg_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  const lines: string[] = [];

  if (opts.to && opts.to.length) {
    lines.push("To: " + opts.to.join(", "));
  }
  lines.push("Subject: " + encodeMimeHeader(opts.subject || ""));
  lines.push("MIME-Version: 1.0");
  lines.push('Content-Type: multipart/mixed; boundary="' + boundary + '"');
  lines.push("");
  lines.push("--" + boundary);
  lines.push('Content-Type: text/plain; charset="UTF-8"');
  lines.push("Content-Transfer-Encoding: base64");
  lines.push("");
  lines.push(wrapBase64(Buffer.from(opts.body || "", "utf-8").toString("base64")));
  lines.push("");

  for (const att of opts.attachments || []) {
    lines.push("--" + boundary);
    lines.push('Content-Type: ' + (att.mimeType || "application/octet-stream") + '; name="' + encodeMimeHeader(att.filename) + '"');
    lines.push("Content-Transfer-Encoding: base64");
    lines.push('Content-Disposition: attachment; filename="' + encodeMimeHeader(att.filename) + '"');
    lines.push("");
    lines.push(wrapBase64(att.content || ""));
    lines.push("");
  }
  lines.push("--" + boundary + "--");

  return lines.join("\r\n");
}

async function getAccessToken(): Promise<{ ok: true; accessToken: string } | { ok: false; error: string }> {
  const clientId = Netlify.env.get("GOOGLE_CLIENT_ID");
  const clientSecret = Netlify.env.get("GOOGLE_CLIENT_SECRET");
  if (!clientId || !clientSecret) return { ok: false, error: "server_not_configured" };

  const store = getStore("googleAuth");
  const data: any = await store.get("gmail", { type: "json" });
  if (!data || !data.refresh_token) return { ok: false, error: "gmail_not_connected" };

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
  if (!res.ok || !tokenData.access_token) {
    return { ok: false, error: "refresh_failed" };
  }
  return { ok: true, accessToken: tokenData.access_token };
}

// プランボード等から、この内容でGmailの下書きを作成する（添付ファイル対応）。
export default async (req: Request, context: Context) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  if (req.method !== "POST") {
    return jsonResponse({ error: "method_not_allowed" }, 405);
  }
  const token = req.headers.get("x-staff-token");
  if (token !== STAFF_PASSPHRASE) {
    return jsonResponse({ error: "unauthorized" }, 401);
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "invalid_json" }, 400);
  }

  const to: string[] = Array.isArray(body.to) ? body.to : body.to ? [String(body.to)] : [];
  const subject = String(body.subject || "");
  const mailBody = String(body.body || "");
  const attachments: Attachment[] = Array.isArray(body.attachments) ? body.attachments : [];

  const tokenResult = await getAccessToken();
  if (!tokenResult.ok) {
    return jsonResponse({ error: tokenResult.error }, tokenResult.error === "gmail_not_connected" ? 409 : 500);
  }

  try {
    const raw = buildMimeMessage({ to, subject, body: mailBody, attachments });
    const rawBase64Url = base64ToBase64Url(Buffer.from(raw, "utf-8").toString("base64"));

    const draftRes = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/drafts", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + tokenResult.accessToken,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ message: { raw: rawBase64Url } }),
    });
    const draftData: any = await draftRes.json();
    if (!draftRes.ok) {
      return jsonResponse({ error: "gmail_api_error", detail: draftData }, 502);
    }
    return jsonResponse({ ok: true, id: draftData.id, attachmentCount: attachments.length });
  } catch (e: any) {
    return jsonResponse({ error: "unexpected_error", detail: e?.message || String(e) }, 500);
  }
};

export const config: Config = {
  path: "/api/gmail-create-draft",
};
