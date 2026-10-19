import type { Context, Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";

// 見積の受領登録で、業者さんから届いたメールの添付ファイル（見積書など）を取り込むための関数。
//  GET  /api/gmail-attachments?threadId=a,b,c
//       → スレッド内の「受信した」メッセージの添付一覧（自分が送ったメール＝SENT は除く）
//  POST /api/gmail-attachments  { slug, messageId, partId }
//       → その添付を Gmail から読み、customerPhotos（staff-upload-photo と同じ置き場）へ直接保存して key を返す。
//         画面からファイルの中身を送らないので、Netlify Functions の受け取り上限（約6MB）にかからない。

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Staff-Token",
};

// staff-auth.mts と同じ値にしてください。
const STAFF_PASSPHRASE = "sumairu2026";

function jsonResponse(obj: any, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

async function getAccessToken(): Promise<{ ok: true; accessToken: string } | { ok: false; error: string }> {
  const clientId = Netlify.env.get("GOOGLE_CLIENT_ID");
  const clientSecret = Netlify.env.get("GOOGLE_CLIENT_SECRET");
  if (!clientId || !clientSecret) return { ok: false, error: "server_not_configured" };
  const store = getStore("googleAuth");
  const data: any = await store.get("gmail", { type: "json", consistency: "strong" });
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
  if (!res.ok || !tokenData.access_token) return { ok: false, error: "refresh_failed" };
  return { ok: true, accessToken: tokenData.access_token };
}

function headerValue(headers: any[], name: string) {
  const h = (headers || []).find((x: any) => (x.name || "").toLowerCase() === name.toLowerCase());
  return h ? h.value || "" : "";
}

function walkParts(part: any, out: any[]) {
  if (!part) return;
  if (part.filename && part.body && part.body.attachmentId) out.push(part);
  (part.parts || []).forEach((p: any) => walkParts(p, out));
}

function b64urlToBytes(s: string) {
  return Uint8Array.from(Buffer.from(String(s || "").replace(/-/g, "+").replace(/_/g, "/"), "base64"));
}

export default async (req: Request, context: Context) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (req.headers.get("x-staff-token") !== STAFF_PASSPHRASE) return jsonResponse({ error: "unauthorized" }, 401);

  const tokenResult = await getAccessToken();
  if (!tokenResult.ok) {
    return jsonResponse({ error: tokenResult.error }, tokenResult.error === "gmail_not_connected" ? 409 : 500);
  }
  const auth = { Authorization: "Bearer " + tokenResult.accessToken };

  try {
    if (req.method === "GET") {
      const url = new URL(req.url);
      const ids = (url.searchParams.get("threadId") || "").split(",").map((x) => x.trim()).filter(Boolean).slice(0, 5);
      if (!ids.length) return jsonResponse({ error: "threadId_required" }, 400);
      const items: any[] = [];
      for (const tid of ids) {
        const tRes = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/threads/" + encodeURIComponent(tid) + "?format=full", { headers: auth });
        if (!tRes.ok) continue;
        const t: any = await tRes.json();
        for (const m of t.messages || []) {
          if ((m.labelIds || []).includes("SENT")) continue; // 自分が送ったメール（依頼メールに付けた図面など）は除く
          const headers = (m.payload && m.payload.headers) || [];
          const parts: any[] = [];
          walkParts(m.payload, parts);
          for (const p of parts) {
            const mime = p.mimeType || "application/octet-stream";
            const size = (p.body && p.body.size) || 0;
            // 署名のロゴなど小さい画像は除く
            if (/^image\//.test(mime) && size < 15000) continue;
            items.push({
              threadId: tid,
              messageId: m.id,
              partId: p.partId,
              filename: p.filename,
              mimeType: mime,
              size,
              sender: headerValue(headers, "From"),
              date: headerValue(headers, "Date"),
              subject: headerValue(headers, "Subject"),
              internalDate: Number(m.internalDate || 0),
            });
          }
        }
      }
      items.sort((a, b) => b.internalDate - a.internalDate);
      return jsonResponse({ items });
    }

    if (req.method === "POST") {
      let body: any;
      try { body = await req.json(); } catch { return jsonResponse({ error: "invalid_json" }, 400); }
      const slug = String((body && body.slug) || "").trim();
      const messageId = String((body && body.messageId) || "").trim();
      const partId = String((body && body.partId) || "").trim();
      if (!slug || !messageId || !partId || /[\/\\]/.test(slug)) return jsonResponse({ error: "bad_request" }, 400);
      // 添付IDはその都度変わることがあるので、メッセージを読み直して partId から探す
      const mRes = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/" + encodeURIComponent(messageId) + "?format=full", { headers: auth });
      if (!mRes.ok) return jsonResponse({ error: "message_not_found" }, 404);
      const m: any = await mRes.json();
      const parts: any[] = [];
      walkParts(m.payload, parts);
      const p = parts.find((x) => String(x.partId) === partId);
      if (!p) return jsonResponse({ error: "attachment_not_found" }, 404);
      const aRes = await fetch(
        "https://gmail.googleapis.com/gmail/v1/users/me/messages/" + encodeURIComponent(messageId) + "/attachments/" + encodeURIComponent(p.body.attachmentId),
        { headers: auth },
      );
      const aData: any = await aRes.json();
      if (!aRes.ok || !aData.data) return jsonResponse({ error: "attachment_fetch_failed" }, 502);
      const bytes = b64urlToBytes(aData.data);
      let contentType = p.mimeType || "application/octet-stream";
      if (contentType === "application/octet-stream" && /\.pdf$/i.test(p.filename || "")) contentType = "application/pdf";
      const key = "p" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
      await getStore("customerPhotos").set(`${slug}/${key}`, bytes, { metadata: { contentType } });
      return jsonResponse({ ok: true, key, contentType, sizeBytes: bytes.length, filename: p.filename });
    }

    return jsonResponse({ error: "method_not_allowed" }, 405);
  } catch (e: any) {
    return jsonResponse({ error: "unexpected_error", detail: e?.message || String(e) }, 500);
  }
};

export const config: Config = {
  path: "/api/gmail-attachments",
};
