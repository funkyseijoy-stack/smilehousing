import type { Context, Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";
import { getAccessToken, CUSTOMER_CALENDAR_ID } from "../lib/google.mts";

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

  // どのGoogleアカウントで連携されているか・実際に付与されているスコープ・
  // 「お客様予約」カレンダーに対する実際のアクセス権限（accessRole）を確認する
  // （カレンダーの権限エラー調査用。共有設定の画面表示と、APIが実際に見ている
  // 権限がズレていないかを切り分けるため）。失敗しても連携状態の表示自体は止めない。
  let email: string | null = null;
  let grantedScope: string | null = null;
  let calendarAccessRole: string | null = null;
  let calendarCheckError: string | null = null;
  if (connected) {
    try {
      const tk = await getAccessToken();
      if (tk.ok) {
        const r = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
          headers: { Authorization: "Bearer " + tk.accessToken },
        });
        if (r.ok) {
          const u: any = await r.json();
          email = u.email || null;
        }
        // アクセストークンに実際に付与されているスコープ（tokeninfoはrefresh_token保存値とは
        // 独立に、今まさに使えるトークンの中身を返す）。
        try {
          const ti = await fetch("https://oauth2.googleapis.com/tokeninfo?access_token=" + encodeURIComponent(tk.accessToken));
          if (ti.ok) { const tiData: any = await ti.json(); grantedScope = tiData.scope || null; }
        } catch { /* 無視 */ }
        // 「お客様予約」カレンダーに対して、このアカウントが実際にどの権限を持っているか
        // （owner/writer/reader/freeBusyReader）。これがGoogle Calendar APIの判定そのもの。
        try {
          const cl = await fetch(
            `https://www.googleapis.com/calendar/v3/users/me/calendarList/${encodeURIComponent(CUSTOMER_CALENDAR_ID)}`,
            { headers: { Authorization: "Bearer " + tk.accessToken } }
          );
          if (cl.ok) {
            const clData: any = await cl.json();
            calendarAccessRole = clData.accessRole || null;
          } else {
            const clErr: any = await cl.json().catch(() => ({}));
            calendarCheckError = `status ${cl.status}: ${(clErr && clErr.error && clErr.error.message) || "不明"}`;
          }
        } catch (e: any) { calendarCheckError = String(e?.message || e); }
      }
    } catch { /* 無視 */ }
  }

  return new Response(JSON.stringify({
    connected,
    connectedAt: connected ? (data as any).connectedAt : null,
    calendar: connected && String((data as any).scope || "").includes("calendar"),
    email,
    grantedScope,
    calendarAccessRole,
    calendarCheckError,
  }), {
    status: 200,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
};

export const config: Config = {
  path: "/api/gmail-status",
};
