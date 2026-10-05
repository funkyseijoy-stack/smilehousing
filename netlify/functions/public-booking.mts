import type { Context, Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";
import { getAccessToken, sendNotifyMail, CUSTOMER_CALENDAR_ID } from "../lib/google.mts";
import { DURATION, OPEN_MIN, CLOSE_MIN, DAYS_AHEAD, WD, toHM, hmToMin, nowJst, addDays, dowOf, buildDays, listCollection } from "../lib/booking.mts";

// 新規のお客様向けの公開予約（/yoyaku/）。ログイン・リンク不要で誰でも使えるページ用。
// 予約の種類は「ショールーム見学＆おうち相談」のみ。空き状況は note-calendar と同じルール
// （netlify/lib/booking.mts）で、同じ「お客様予約」カレンダーを見るので既存のお客様の予約とは重ならない。
// 予約が入ったら、カレンダーに登録 → reservations に保存（projectId なし・source:"public"）→ スタッフへ通知メール。
// 誰でも叩けるため、入力チェック・ハニーポット・同じ電話番号/メールの重複上限・1日の受付上限を入れている。

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};
function json(obj: any, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

const BOOKING_TYPE = "ショールーム見学＆おうち相談";
const MAX_UPCOMING_PER_CONTACT = 2; // 同じ電話番号・メールで、今後の予約を持てる件数
const MAX_PER_DAY = 15; // 24時間に受け付ける公開予約の上限（いたずら・連打対策）

const toHalf = (s: string) => s.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0)).replace(/[ー－―‐]/g, "-");
const digits = (s: string) => toHalf(s).replace(/\D/g, "");
const clean = (v: any, max: number) => String(v == null ? "" : v).replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max);

export default async (req: Request, context: Context) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (req.method !== "GET" && req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  const store = getStore("staffData");
  const tk = await getAccessToken();
  if (!tk.ok) return json({ error: "unavailable" }, 503);
  const today = nowJst().date;
  const horizon = addDays(today, DAYS_AHEAD - 1);

  try {
    // ---------- 空き状況 ----------
    if (req.method === "GET") {
      const days = await buildDays(tk.accessToken, store, today, horizon);
      return json({ type: BOOKING_TYPE, durationMinutes: DURATION, open: toHM(OPEN_MIN), close: toHM(CLOSE_MIN), days });
    }

    // ---------- 予約する ----------
    let body: any;
    try { body = await req.json(); } catch { return json({ error: "invalid_json" }, 400); }
    if (body.action !== "book") return json({ error: "unknown_action" }, 400);
    // ハニーポット（人には見えない欄。入っていたらボットとみなし、成功したように見せて何もしない）
    if (clean(body.website, 100)) return json({ ok: true, reservation: null });

    const name = clean(body.name, 50);
    const phone = toHalf(clean(body.phone, 20));
    const email = clean(body.email, 100);
    const notes = String(body.notes == null ? "" : body.notes).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim().slice(0, 500);
    const date = String(body.date || "");
    const start = String(body.start || "");
    if (!name) return json({ error: "name_required" }, 400);
    const phoneDigits = digits(phone);
    if (phoneDigits.length < 10 || phoneDigits.length > 11 || !/^[0-9()\-\s+]+$/.test(phone)) return json({ error: "invalid_phone" }, 400);
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ error: "invalid_email" }, 400);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date < today || date > horizon) return json({ error: "invalid_date" }, 400);
    if (!/^\d{2}:\d{2}$/.test(start)) return json({ error: "invalid_start" }, 400);

    // 同じ連絡先の重複・1日の上限
    const resvs = await listCollection(store, "reservations");
    const publics = resvs.filter((r: any) => r.source === "public");
    const sinceMs = Date.now() - 24 * 3600 * 1000;
    if (publics.filter((r: any) => Date.parse(r.createdAt || "") > sinceMs).length >= MAX_PER_DAY) return json({ error: "too_many" }, 429);
    const mine = publics.filter((r: any) =>
      r.date >= today && ((r.phone && digits(r.phone) === phoneDigits) || (email && r.email && r.email.toLowerCase() === email.toLowerCase())));
    if (mine.length >= MAX_UPCOMING_PER_CONTACT) return json({ error: "already_booked" }, 409);

    // 直前に空きを取り直して、同じ枠が先に埋まっていないか確認する
    const days = await buildDays(tk.accessToken, store, date, date);
    const slot = days[0]?.slots.find((s: any) => s.start === start);
    if (!slot || !slot.available) return json({ error: "slot_taken" }, 409);

    const end = toHM(hmToMin(start) + DURATION);
    const evRes = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(CUSTOMER_CALENDAR_ID)}/events`,
      {
        method: "POST",
        headers: { Authorization: "Bearer " + tk.accessToken, "Content-Type": "application/json" },
        body: JSON.stringify({
          summary: `${BOOKING_TYPE}（${name}様・新規）`,
          description: `予約ページ（新規のお客様）からのご予約\nお名前：${name}\n電話：${phone}\nメール：${email || "（未入力）"}\nご相談内容：${notes || "（未入力）"}`,
          start: { dateTime: `${date}T${start}:00+09:00`, timeZone: "Asia/Tokyo" },
          end: { dateTime: `${date}T${end}:00+09:00`, timeZone: "Asia/Tokyo" },
        }),
      }
    );
    const ev: any = await evRes.json();
    if (!evRes.ok) return json({ error: "calendar_insert_failed" }, 502);

    const id = "rv_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    const now = new Date().toISOString();
    await store.setJSON(`reservations/${id}`, {
      id, projectId: "", type: BOOKING_TYPE, staff: "", date, startTime: start, durationMinutes: DURATION, endTime: end,
      customerName: name, phone, email, notes, googleEventId: ev.id || null, source: "public", createdAt: now, updatedAt: now,
    });

    const mailed = await sendNotifyMail(
      `【新規予約】${name}様が${BOOKING_TYPE}を予約されました`,
      `新規のお客様が、予約ページから予約されました。\n\n` +
        `種類：${BOOKING_TYPE}\n日時：${date}（${WD[dowOf(date)]}） ${start}〜${end}\n\n` +
        `お名前：${name}\n電話：${phone}\nメール：${email || "（未入力）"}\nご相談内容：${notes || "（未入力）"}\n\n` +
        `「お客様予約」カレンダーにも登録済みです。`
    );
    return json({ ok: true, reservation: { type: BOOKING_TYPE, date, startTime: start, endTime: end }, notified: mailed });
  } catch (e: any) {
    return json({ error: "calendar_error" }, 502);
  }
};

export const config: Config = {
  path: "/api/public-booking",
};
