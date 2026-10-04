import type { Context, Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";
import { getAccessToken, sendNotifyMail, CUSTOMER_CALENDAR_ID, HOLIDAY_CALENDAR_ID } from "../lib/google.mts";

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
const DURATION = 120; // 分（どの種類も2時間）
const OPEN_MIN = 9 * 60;
const CLOSE_MIN = 17 * 60;
const STEP = 30;
const DAYS_AHEAD = 28;
const LEAD_MIN = 60; // 当日は1時間後以降の開始のみ
const WD = ["日", "月", "火", "水", "木", "金", "土"];

const pad = (n: number) => String(n).padStart(2, "0");
const toHM = (m: number) => `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
const hmToMin = (s: string) => { const [h, m] = s.split(":").map(Number); return h * 60 + m; };

// JST の「今」を { date: YYYY-MM-DD, min: 0-1439 } で返す
function nowJst() {
  const d = new Date(Date.now() + 9 * 3600 * 1000);
  return { date: d.toISOString().slice(0, 10), min: d.getUTCHours() * 60 + d.getUTCMinutes() };
}
function addDays(date: string, n: number) {
  const d = new Date(date + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function dowOf(date: string) { return new Date(date + "T00:00:00Z").getUTCDay(); }

async function listCollection(store: any, name: string, projectId?: string) {
  const { blobs } = await store.list({ prefix: name + "/" });
  const items = await Promise.all(blobs.map((b: any) => store.get(b.key, { type: "json" })));
  return (items.filter(Boolean) as any[]).filter((x) => !x.deletedAt && (projectId ? x.projectId === projectId : true));
}

type Busy = { date: string; start: number; end: number };

// Google カレンダーの予定（お客様予約）→ 日別の使用中時間
async function calendarBusy(accessToken: string, from: string, to: string): Promise<Busy[]> {
  const u = new URL(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(CUSTOMER_CALENDAR_ID)}/events`);
  u.searchParams.set("timeMin", `${from}T00:00:00+09:00`);
  u.searchParams.set("timeMax", `${addDays(to, 1)}T00:00:00+09:00`);
  u.searchParams.set("singleEvents", "true");
  u.searchParams.set("maxResults", "500");
  u.searchParams.set("timeZone", "Asia/Tokyo");
  const res = await fetch(u.toString(), { headers: { Authorization: "Bearer " + accessToken } });
  if (!res.ok) throw new Error("calendar_list_failed:" + res.status);
  const data: any = await res.json();
  const out: Busy[] = [];
  for (const ev of data.items || []) {
    if (ev.status === "cancelled") continue;
    if (ev.start?.date) {
      // 終日予定は、公開設定（空き時間／予定あり）に関わらず、その日を丸ごと使用中にする。
      // 定休日などを示す目印として終日予定を使うことが多く、その場合「空き時間」のままでも
      // 必ずブロックしたいため、ここでは transparency を見ない。
      let d = ev.start.date;
      const endD = ev.end?.date || addDays(d, 1);
      while (d < endD) { out.push({ date: d, start: 0, end: 24 * 60 }); d = addDays(d, 1); }
      continue;
    }
    if (ev.transparency === "transparent") continue;
    if (!ev.start?.dateTime || !ev.end?.dateTime) continue;
    // timeZone=Asia/Tokyo を指定しているので、dateTime は +09:00 表記で返る
    const sd = ev.start.dateTime.slice(0, 10), ed = ev.end.dateTime.slice(0, 10);
    const sm = hmToMin(ev.start.dateTime.slice(11, 16)), em = hmToMin(ev.end.dateTime.slice(11, 16));
    if (sd === ed) out.push({ date: sd, start: sm, end: em });
    else { // 日をまたぐ予定
      out.push({ date: sd, start: sm, end: 24 * 60 });
      let d = addDays(sd, 1);
      while (d < ed) { out.push({ date: d, start: 0, end: 24 * 60 }); d = addDays(d, 1); }
      if (em > 0) out.push({ date: ed, start: 0, end: em });
    }
  }
  return out;
}

// 日本の祝日（取得できなければ空。祝日を除外できないだけで、予約自体は止めない）
async function holidays(accessToken: string, from: string, to: string): Promise<Set<string>> {
  const set = new Set<string>();
  try {
    const u = new URL(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(HOLIDAY_CALENDAR_ID)}/events`);
    u.searchParams.set("timeMin", `${from}T00:00:00+09:00`);
    u.searchParams.set("timeMax", `${addDays(to, 1)}T00:00:00+09:00`);
    u.searchParams.set("singleEvents", "true");
    u.searchParams.set("maxResults", "100");
    const res = await fetch(u.toString(), { headers: { Authorization: "Bearer " + accessToken } });
    if (!res.ok) return set;
    const data: any = await res.json();
    for (const ev of data.items || []) if (ev.start?.date) set.add(ev.start.date);
  } catch { /* 無視 */ }
  return set;
}

async function buildDays(accessToken: string, store: any, from: string, to: string) {
  const [calBusy, resvs, hol] = await Promise.all([
    calendarBusy(accessToken, from, to),
    listCollection(store, "reservations"),
    holidays(accessToken, from, to),
  ]);
  const busy: Busy[] = calBusy.slice();
  for (const r of resvs) {
    if (!r.date || !r.startTime || !r.endTime) continue;
    busy.push({ date: r.date, start: hmToMin(r.startTime), end: hmToMin(r.endTime) });
  }
  const now = nowJst();
  const days: any[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) {
    const dow = dowOf(d);
    const base = { date: d, dow, wd: WD[dow] };
    if (dow === 0) { days.push({ ...base, status: "closed", reason: "日曜", slots: [] }); continue; }
    if (hol.has(d)) { days.push({ ...base, status: "closed", reason: "祝日", slots: [] }); continue; }
    const dayBusy = busy.filter((b) => b.date === d);
    const slots: { start: string; available: boolean }[] = [];
    for (let s = OPEN_MIN; s + DURATION <= CLOSE_MIN; s += STEP) {
      let ok = !dayBusy.some((b) => s < b.end && b.start < s + DURATION);
      if (d === now.date && s < now.min + LEAD_MIN) ok = false;
      if (d < now.date) ok = false;
      slots.push({ start: toHM(s), available: ok });
    }
    days.push({ ...base, status: slots.some((x) => x.available) ? "open" : "full", slots });
  }
  return days;
}

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
