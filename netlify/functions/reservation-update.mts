import type { Context, Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";
import { getAccessToken, CUSTOMER_CALENDAR_ID } from "../lib/google.mts";
import { calendarBusy, listCollection, hmToMin, toHM, dowOf, BUFFER_AFTER_MIN, CLOSE_MIN, OPEN_MIN } from "../lib/booking.mts";

// スタッフが予約の内容（日時・担当・種別・メモ・お客様情報）を編集する。
// 日時を変えたときは、他の予約・カレンダーの予定との重なりを確認し（force:true なら重なっていても変更）、
// Googleカレンダー「お客様予約」の予定も新しい日時に更新する（予定の更新に失敗しても予約は保存し、結果を返す）。
// 認証は他の機能と同じ合言葉（X-Staff-Token）。

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Staff-Token",
};
// staff-auth.mts と同じ値にしてください。
const STAFF_PASSPHRASE = "sumairu2026";
const TYPES = ["来店", "オンライン", "銀行", "ショールーム"];

function json(obj: any, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}
const clean = (v: any, max: number) => String(v ?? "").trim().slice(0, max);

export default async (req: Request, context: Context) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  if (req.headers.get("x-staff-token") !== STAFF_PASSPHRASE) return json({ error: "unauthorized" }, 401);

  let body: any;
  try { body = await req.json(); } catch { return json({ error: "invalid_json" }, 400); }
  const id = clean(body.reservationId, 80);
  const p = body.patch || {};
  if (!id) return json({ error: "missing_fields" }, 400);

  const store = getStore("staffData");
  const r: any = await store.get(`reservations/${id}`, { type: "json" });
  if (!r || r.deletedAt) return json({ error: "not_found" }, 404);

  const next: any = { ...r };
  if (p.type !== undefined) { if (!TYPES.includes(p.type)) return json({ error: "invalid_type" }, 400); next.type = p.type; }
  if (p.staff !== undefined) next.staff = clean(p.staff, 30);
  if (p.notes !== undefined) next.notes = clean(p.notes, 2000);
  if (r.source === "public") {
    if (p.customerName !== undefined) {
      const n = clean(p.customerName, 60);
      if (!n) return json({ error: "name_required" }, 400);
      next.customerName = n;
    }
    if (p.phone !== undefined) next.phone = clean(p.phone, 30);
    if (p.email !== undefined) {
      const e = clean(p.email, 120);
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) return json({ error: "invalid_email" }, 400);
      next.email = e;
    }
  }

  // 日時
  const date = p.date !== undefined ? clean(p.date, 10) : r.date;
  const startTime = p.startTime !== undefined ? clean(p.startTime, 5) : r.startTime;
  const duration = p.durationMinutes !== undefined ? Math.round(Number(p.durationMinutes)) : (r.durationMinutes || (hmToMin(r.endTime) - hmToMin(r.startTime)));
  const timeChanged = date !== r.date || startTime !== r.startTime || duration !== (r.durationMinutes || (hmToMin(r.endTime) - hmToMin(r.startTime)));
  let calendarUpdated: boolean | null = null;

  if (timeChanged) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || isNaN(new Date(date + "T00:00:00Z").getTime())) return json({ error: "invalid_date" }, 400);
    if (!/^\d{2}:\d{2}$/.test(startTime) || !Number.isFinite(duration) || duration < 30 || duration > 480) return json({ error: "invalid_time" }, 400);
    const s = hmToMin(startTime), e = s + duration;
    if (dowOf(date) === 0) return json({ error: "closed_day", message: "日曜日は定休日です" }, 400);
    if (s < OPEN_MIN || e > CLOSE_MIN) return json({ error: "out_of_hours", message: "受付時間（9:00〜17:00）の範囲にしてください" }, 400);

    // 重なりの確認（他の予約・カレンダーの予定。終了後の1時間の間隔も含める）。force:true なら確認せず変更する。
    let tk: any = null;
    try { tk = await getAccessToken(); } catch { tk = null; }
    if (!body.force) {
      const busy: { start: number; end: number }[] = [];
      const others = (await listCollection(store, "reservations")).filter((x: any) => x.id !== id && x.date === date && x.startTime && x.endTime);
      for (const o of others) busy.push({ start: hmToMin(o.startTime), end: Math.min(24 * 60, hmToMin(o.endTime) + BUFFER_AFTER_MIN) });
      if (tk?.ok) {
        try {
          const cal = await calendarBusy(tk.accessToken, date, date, r.googleEventId || null);
          for (const c of cal) if (c.date === date) busy.push({ start: c.start, end: c.end });
        } catch { /* カレンダーが見られないときは予約データだけで判定 */ }
      }
      const hit = busy.find((b) => s < b.end && b.start < e);
      if (hit) return json({ error: "conflict", message: `その時間は他の予定と重なっています（〜${toHM(Math.max(0, hit.end - BUFFER_AFTER_MIN))}ごろまで予定あり）` }, 409);
    }

    next.date = date; next.startTime = startTime; next.durationMinutes = duration; next.endTime = toHM(e);

    if (r.googleEventId) {
      calendarUpdated = false;
      try {
        if (tk?.ok) {
          const res = await fetch(
            `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(CUSTOMER_CALENDAR_ID)}/events/${encodeURIComponent(r.googleEventId)}`,
            {
              method: "PATCH",
              headers: { Authorization: "Bearer " + tk.accessToken, "Content-Type": "application/json" },
              body: JSON.stringify({
                start: { dateTime: `${date}T${startTime}:00+09:00`, timeZone: "Asia/Tokyo" },
                end: { dateTime: `${date}T${next.endTime}:00+09:00`, timeZone: "Asia/Tokyo" },
              }),
            }
          );
          calendarUpdated = res.ok;
        }
      } catch { calendarUpdated = false; }
    }
    // 日時を変えたので、前日リマインドは新しい日時で送り直す（まだ送っていない状態に戻す）
    if (r.reminderSentAt) delete next.reminderSentAt;
  }

  const now = new Date().toISOString();
  next.updatedAt = now;
  const log = Array.isArray(r.editLog) ? r.editLog.slice(-19) : [];
  log.push({ at: now, by: clean(body.by, 30), timeChanged });
  next.editLog = log;
  await store.setJSON(`reservations/${id}`, next);
  return json({ ok: true, calendarUpdated, reservation: next });
};

export const config: Config = {
  path: "/api/reservation-update",
};
