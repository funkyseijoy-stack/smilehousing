import type { Context, Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
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

function headerValue(headers: any[], name: string) {
  const h = (headers || []).find((x: any) => (x.name || "").toLowerCase() === name.toLowerCase());
  return h ? h.value || "" : "";
}

// 受信箱を検索して、スレッド一覧（送信者・件名・抜粋・日時・Gmailで開くリンク）を返す。
// 本文までは取得しない（一覧表示に必要な最小限のメタデータのみ）。
export default async (req: Request, context: Context) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  const token = req.headers.get("x-staff-token");
  if (token !== STAFF_PASSPHRASE) {
    return jsonResponse({ error: "unauthorized" }, 401);
  }

  const url = new URL(req.url);
  const q = url.searchParams.get("q") || "in:inbox";
  const maxResults = Math.min(parseInt(url.searchParams.get("maxResults") || "50", 10) || 50, 100);
  const pageToken = url.searchParams.get("pageToken") || "";

  const tokenResult = await getAccessToken();
  if (!tokenResult.ok) {
    return jsonResponse({ error: tokenResult.error }, tokenResult.error === "gmail_not_connected" ? 409 : 500);
  }
  const accessToken = tokenResult.accessToken;
  const authHeader = { Authorization: "Bearer " + accessToken };

  try {
    const listUrl = new URL("https://gmail.googleapis.com/gmail/v1/users/me/threads");
    listUrl.searchParams.set("q", q);
    listUrl.searchParams.set("maxResults", String(maxResults));
    if (pageToken) listUrl.searchParams.set("pageToken", pageToken);
    const listRes = await fetch(listUrl.toString(), { headers: authHeader });
    const listData: any = await listRes.json();
    if (!listRes.ok) {
      return jsonResponse({ error: "gmail_api_error", detail: listData }, 502);
    }
    const threadRefs: any[] = listData.threads || [];

    // 各スレッドの最新メッセージのメタデータ（送信者・件名・日時・抜粋）だけを取得する。
    const threads = await Promise.all(
      threadRefs.map(async (t: any) => {
        try {
          const tUrl = new URL("https://gmail.googleapis.com/gmail/v1/users/me/threads/" + t.id);
          tUrl.searchParams.set("format", "metadata");
          tUrl.searchParams.append("metadataHeaders", "From");
          tUrl.searchParams.append("metadataHeaders", "Subject");
          tUrl.searchParams.append("metadataHeaders", "Date");
          const tRes = await fetch(tUrl.toString(), { headers: authHeader });
          const tData: any = await tRes.json();
          const msgs = tData.messages || [];
          const lastMsg = msgs[msgs.length - 1] || {};
          const headers = (lastMsg.payload && lastMsg.payload.headers) || [];
          return {
            id: t.id,
            sender: headerValue(headers, "From"),
            subject: headerValue(headers, "Subject") || "(件名なし)",
            snippet: lastMsg.snippet || t.snippet || "",
            date: headerValue(headers, "Date"),
            viewUrl: "https://mail.google.com/mail/u/0/#all/" + t.id,
          };
        } catch {
          return {
            id: t.id,
            sender: "",
            subject: "(読み込みエラー)",
            snippet: t.snippet || "",
            date: "",
            viewUrl: "https://mail.google.com/mail/u/0/#all/" + t.id,
          };
        }
      })
    );

    return jsonResponse({ threads, nextPageToken: listData.nextPageToken || null, resultSizeEstimate: listData.resultSizeEstimate });
  } catch (e: any) {
    return jsonResponse({ error: "unexpected_error", detail: e?.message || String(e) }, 500);
  }
};

export const config: Config = {
  path: "/api/gmail-search-threads",
};
