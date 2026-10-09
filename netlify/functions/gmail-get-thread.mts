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

// 業者からの返信確認用：指定したスレッドのメッセージ一覧（送信者・抜粋・日時）を返す。
export default async (req: Request, context: Context) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  const token = req.headers.get("x-staff-token");
  if (token !== STAFF_PASSPHRASE) {
    return jsonResponse({ error: "unauthorized" }, 401);
  }

  const url = new URL(req.url);
  const threadId = url.searchParams.get("threadId") || "";
  if (!threadId) {
    return jsonResponse({ error: "threadId_required" }, 400);
  }

  const tokenResult = await getAccessToken();
  if (!tokenResult.ok) {
    return jsonResponse({ error: tokenResult.error }, tokenResult.error === "gmail_not_connected" ? 409 : 500);
  }

  try {
    const tUrl = new URL("https://gmail.googleapis.com/gmail/v1/users/me/threads/" + threadId);
    tUrl.searchParams.set("format", "metadata");
    tUrl.searchParams.append("metadataHeaders", "From");
    tUrl.searchParams.append("metadataHeaders", "Date");
    tUrl.searchParams.append("metadataHeaders", "Subject");
    const tRes = await fetch(tUrl.toString(), { headers: { Authorization: "Bearer " + tokenResult.accessToken } });
    const tData: any = await tRes.json();
    if (!tRes.ok) {
      return jsonResponse({ error: "gmail_api_error", detail: tData }, 502);
    }
    const messages = (tData.messages || []).map((m: any) => {
      const headers = (m.payload && m.payload.headers) || [];
      return {
        sender: headerValue(headers, "From"),
        date: headerValue(headers, "Date"),
        subject: headerValue(headers, "Subject"),
        snippet: m.snippet || "",
      };
    });
    return jsonResponse({ messages });
  } catch (e: any) {
    return jsonResponse({ error: "unexpected_error", detail: e?.message || String(e) }, 500);
  }
};

export const config: Config = {
  path: "/api/gmail-get-thread",
};
