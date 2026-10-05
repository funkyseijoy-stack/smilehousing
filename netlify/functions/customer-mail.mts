import type { Context, Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";
import { getAccessToken, sendMailTo, CUSTOMER_MAIL_FROM_NAME, CUSTOMER_CALENDAR_ID } from "../lib/google.mts";

// スタッフが、新規のお客様（予約ページから予約した方）へメールを送る（日時変更・キャンセルのお知らせ・自由なメッセージ）。
// 宛先は、その予約に保存されているメールアドレスだけ（任意の宛先には送れない）。
// 文面（件名・本文）は住まいるアプリ側でスタッフが確認・編集したものを受け取る。
// kind:"cancel" のときは、その予約を一覧・空き状況から外す（ごみ箱に入る）。deleteEvent:true なら Googleカレンダー「お客様予約」の予定も削除する。
// 認証は他の機能と同じ合言葉（X-Staff-Token）。

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Staff-Token",
};
// staff-auth.mts と同じ値にしてください。
const STAFF_PASSPHRASE = "sumairu2026";

function json(obj: any, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

export default async (req: Request, context: Context) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  if (req.headers.get("x-staff-token") !== STAFF_PASSPHRASE) return json({ error: "unauthorized" }, 401);

  let body: any;
  try { body = await req.json(); } catch { return json({ error: "invalid_json" }, 400); }
  const id = String(body.reservationId || "");
  const subject = String(body.subject || "").trim().slice(0, 200);
  const text = String(body.body || "").trim().slice(0, 5000);
  const kind = ["free", "change", "cancel"].includes(body.kind) ? body.kind : "free";
  if (!id || !subject || !text) return json({ error: "missing_fields" }, 400);

  const store = getStore("staffData");
  const r: any = await store.get(`reservations/${id}`, { type: "json" });
  if (!r || r.deletedAt || r.source !== "public" || !r.email) return json({ error: "not_found" }, 404);

  const sent = await sendMailTo({ to: r.email, subject, body: text, fromName: CUSTOMER_MAIL_FROM_NAME });
  if (!sent.ok) return json({ error: "send_failed" }, 502);

  // カレンダーの予定も削除（キャンセルのときだけ・任意）。失敗してもメールは送信済みなので、結果だけ返す。
  let eventDeleted: boolean | null = null;
  if (kind === "cancel" && body.deleteEvent && r.googleEventId) {
    try {
      const tk = await getAccessToken();
      if (tk.ok) {
        const res = await fetch(
          `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(CUSTOMER_CALENDAR_ID)}/events/${encodeURIComponent(r.googleEventId)}`,
          { method: "DELETE", headers: { Authorization: "Bearer " + tk.accessToken } }
        );
        eventDeleted = res.ok || res.status === 410 || res.status === 404;
      } else eventDeleted = false;
    } catch { eventDeleted = false; }
  }

  const now = new Date().toISOString();
  const log = Array.isArray(r.mailLog) ? r.mailLog.slice(-19) : [];
  log.push({ at: now, kind, subject, by: String(body.by || "").slice(0, 30) });
  const next: any = { ...r, mailLog: log, updatedAt: now };
  if (kind === "cancel") {
    // キャンセル：一覧と空き状況から外す（ごみ箱に入る。復元も可能）
    next.cancelledAt = now; next.deletedAt = now; next.deletedBy = String(body.by || "").slice(0, 30);
    if (eventDeleted) next.googleEventId = null;
  }
  await store.setJSON(`reservations/${id}`, next);
  return json({ ok: true, eventDeleted, reservation: next });
};

export const config: Config = {
  path: "/api/customer-mail",
};
