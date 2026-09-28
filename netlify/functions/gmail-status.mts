import type { Context, Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Staff-Token",
};

// staff-auth.mts と同じ値にしてください。
const STAFF_PASSPHRASE = "sumairu2026";

// Gmail連携が済んでいるかどうかをアプリ側から確認するための軽量エンドポイント。
export default async (req: Request, context: Context) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  const token = req.headers.get("x-staff-token");
  if (token !== STAFF_PASSPHRASE) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }

  const store = getStore("googleAuth");
  const data = await store.get("gmail", { type: "json" });
  const connected = !!(data && (data as any).refresh_token);

  return new Response(JSON.stringify({ connected, connectedAt: connected ? (data as any).connectedAt : null }), {
    status: 200,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
};

export const config: Config = {
  path: "/api/gmail-status",
};
