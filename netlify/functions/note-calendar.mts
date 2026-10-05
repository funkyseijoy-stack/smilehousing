import type { Context, Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";
import { getAccessToken, sendNotifyMail, CUSTOMER_CALENDAR_ID } from "../lib/google.mts";
import { DURATION, OPEN_MIN, CLOSE_MIN, DAYS_AHEAD, WD, toHM, hmToMin, nowJst, addDays, dowOf, buildDays } from "../lib/booking.mts";

// おうちノート（お客様画面）の打合せ予約。
// 空き状況は Google カレンダー「お客様予約」＋ 住まいるアプリの予約（reservations）から判定し、
// 予約が確定したら同カレンダーに予定を登録して、スタッフへ通知メールを送る。
// 認証は note-data と同じ案件ごとの noteToken。

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

const TYPES = ["来店", "オンライン", "銀行", "ショールーム"];

export default async (req: Request, context: Context) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
  const store = getStore("staffData");
  const url = new URL(req.url);
  let body: any = {};
  if (req.method === "POST") {
    try { body = await req.json(); } catch { return json({ error: "invalid_json" }, 400); }
  }
  const projectId = String((req.method === "POST" ? body.p : url.searchParams.get("p")) || "");
  const token = String((req.method === "POST" ? body.t : url.searchParams.get("t")) || "");
  if (!projectId || !token) return json({ error: "missing_link" }, 400);
  const project: any = await store.get(`projects/${projectId}`, { type: "json" });
  if (!project || project.deletedAt || !project.noteToken || project.noteToken !== token) {
    return json({ error: "forbidden" }, 403);
  }

  const tk = await getAccessToken();
  if (!tk.ok) return json({ error: tk.error }, 503);
  const today = nowJst().date;
  const horizon = addDays(today, DAYS_AHEAD - 1);

  try {
    // ---------- 空き状況 ----------
    if (req.method === "GET") {
      const days = await buildDays(tk.accessToken, store, today, horizon);
      return json({ types: TYPES, durationMinutes: DURATION, open: toHM(OPEN_MIN), close: toHM(CLOSE_MIN), days });
    }

    // ---------- 予約する ----------
    if (body.action !== "book") return json({ error: "unknown_action" }, 400);
    const type = String(body.type || "");
    const date = String(body.date || "");
    const start = String(body.start || "");
    if (!TYPES.includes(type)) return json({ error: "invalid_type" }, 400);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date < today || date > horizon) return json({ error: "invalid_date" }, 400);
    // 直前に空きを取り直して、同じ枠が先に埋まっていないか確認する
    const days = await buildDays(tk.accessToken, store, date, date);
    const slot = days[0]?.slots.find((s: any) => s.start === start);
    if (!slot || !slot.available) return json({ error: "slot_taken" }, 409);

    const end = toHM(hmToMin(start) + DURATION);
    const customer = project.customer || project.name || "お客様";
    const evRes = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(CUSTOMER_CALENDAR_ID)}/events`,
      {
        method: "POST",
        headers: { Authorization: "Bearer " + tk.accessToken, "Content-Type": "application/json" },
        body: JSON.stringify({
          summary: `${type}（${customer}様）`,
          description: `おうちノートからのご予約\n案件：${project.name || ""}\nお客様：${customer}`,
          start: { dateTime: `${date}T${start}:00+09:00`, timeZone: "Asia/Tokyo" },
          end: { dateTime: `${date}T${end}:00+09:00`, timeZone: "Asia/Tokyo" },
        }),
      }
    );
    const ev: any = await evRes.json();
    if (!evRes.ok) {
      const detail = (ev && ev.error && (ev.error.message || ev.error.status)) || "";
      return json({ error: "calendar_insert_failed", status: evRes.status, detail }, 502);
    }

    const id = "rv_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    const now = new Date().toISOString();
    const doc = {
      id, projectId, type, staff: "", date, startTime: start, durationMinutes: DURATION, endTime: end,
      notes: "おうちノートから予約", googleEventId: ev.id || null, source: "note", createdAt: now, updatedAt: now,
    };
    await store.setJSON(`reservations/${id}`, doc);

    const mailed = await sendNotifyMail(
      `【おうちノート】${customer}様が${type}を予約されました`,
      `${customer}様（${project.name || ""}）が、おうちノートから予約されました。\n\n` +
        `種類：${type}\n日時：${date}（${WD[dowOf(date)]}） ${start}〜${end}\n\n` +
        `「お客様予約」カレンダーにも登録済みです。`
    );
    return json({ ok: true, reservation: { type, date, startTime: start, endTime: end, staff: "" }, notified: mailed });
  } catch (e: any) {
    return json({ error: "calendar_error", detail: String(e?.message || e) }, 502);
  }
};

export const config: Config = {
  path: "/api/note-calendar",
};
