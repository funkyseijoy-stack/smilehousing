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
        // calendarList系のAPIはcalendar.eventsスコープでは使えない（別の権限区分）ため、
        // 実際の予約処理と全く同じ方法（calendar.eventsスコープでのevents.insert）で
        // テスト用の予定を作成→即削除してみて、本物のエラー内容を確認する。
        try {
          const farDate = "2099-01-01"; // 予約の空き状況計算に影響しない、十分先の日付
          const insRes = await fetch(
            `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(CUSTOMER_CALENDAR_ID)}/events`,
            {
              method: "POST",
              headers: { Authorization: "Bearer " + tk.accessToken, "Content-Type": "application/json" },
              body: JSON.stringify({
                summary: "[自動テスト・権限確認用／即削除されます]",
                start: { date: farDate },
                end: { date: farDate },
              }),
            }
          );
          const insBody: any = await insRes.json().catch(() => ({}));
          if (insRes.ok) {
            calendarAccessRole = "writer（書き込みテスト成功）";
            if (insBody.id) {
              await fetch(
                `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(CUSTOMER_CALENDAR_ID)}/events/${insBody.id}`,
                { method: "DELETE", headers: { Authorization: "Bearer " + tk.accessToken } }
              ).catch(() => {});
            }
          } else {
            calendarCheckError = `status ${insRes.status}: ${JSON.stringify(insBody).slice(0, 500)}`;
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
