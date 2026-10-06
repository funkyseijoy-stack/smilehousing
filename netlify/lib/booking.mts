import { CUSTOMER_CALENDAR_ID, HOLIDAY_CALENDAR_ID } from "./google.mts";

// 予約の空き状況まわりの共通処理（おうちノートの予約 note-calendar と、新規のお客様向けの
// 公開予約 public-booking の両方で使う）。ルール（受付時間・枠・間隔・日曜祝日）を変える時は
// ここだけ直せば両方に反映される。
// 空き状況は Google カレンダー「お客様予約」＋ 住まいるアプリの予約（reservations）から判定する。

export const DURATION = 120; // 分（どの種類も2時間）
export const OPEN_MIN = 9 * 60;
export const CLOSE_MIN = 17 * 60;
export const STEP = 30;
export const DAYS_AHEAD = 28;
export const LEAD_MIN = 60; // 当日は1時間後以降の開始のみ
export const BUFFER_AFTER_MIN = 60; // 予約と予約の間を1時間空ける（前の予定の終了直後は予約不可にする）
export const WD = ["日", "月", "火", "水", "木", "金", "土"];

export const pad = (n: number) => String(n).padStart(2, "0");
export const toHM = (m: number) => `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
export const hmToMin = (s: string) => { const [h, m] = s.split(":").map(Number); return h * 60 + m; };

// JST の「今」を { date: YYYY-MM-DD, min: 0-1439 } で返す
export function nowJst() {
  const d = new Date(Date.now() + 9 * 3600 * 1000);
  return { date: d.toISOString().slice(0, 10), min: d.getUTCHours() * 60 + d.getUTCMinutes() };
}
export function addDays(date: string, n: number) {
  const d = new Date(date + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
export function dowOf(date: string) { return new Date(date + "T00:00:00Z").getUTCDay(); }

export async function listCollection(store: any, name: string, projectId?: string) {
  const { blobs } = await store.list({ prefix: name + "/" });
  const items = await Promise.all(blobs.map((b: any) => store.get(b.key, { type: "json" })));
  return (items.filter(Boolean) as any[]).filter((x) => !x.deletedAt && (projectId ? x.projectId === projectId : true));
}

export type Busy = { date: string; start: number; end: number };

// Google カレンダーの予定（お客様予約）→ 日別の使用中時間
export async function calendarBusy(accessToken: string, from: string, to: string, excludeEventId?: string | null): Promise<Busy[]> {
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
    if (excludeEventId && ev.id === excludeEventId) continue; // 予約の編集時：その予約自身の予定は重なり判定から外す
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
    // 終了後にBUFFER_AFTER_MIN分の空きを確保する（次の予約が間髪入れずに入らないように）
    const emBuf = Math.min(24 * 60, em + BUFFER_AFTER_MIN);
    if (sd === ed) out.push({ date: sd, start: sm, end: emBuf });
    else { // 日をまたぐ予定
      out.push({ date: sd, start: sm, end: 24 * 60 });
      let d = addDays(sd, 1);
      while (d < ed) { out.push({ date: d, start: 0, end: 24 * 60 }); d = addDays(d, 1); }
      if (em > 0) out.push({ date: ed, start: 0, end: emBuf });
    }
  }
  return out;
}

// 日本の祝日（取得できなければ空。祝日を除外できないだけで、予約自体は止めない）
export async function holidays(accessToken: string, from: string, to: string): Promise<Set<string>> {
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

export async function buildDays(accessToken: string, store: any, from: string, to: string) {
  const [calBusy, resvs, hol] = await Promise.all([
    calendarBusy(accessToken, from, to),
    listCollection(store, "reservations"),
    holidays(accessToken, from, to),
  ]);
  const busy: Busy[] = calBusy.slice();
  for (const r of resvs) {
    if (!r.date || !r.startTime || !r.endTime) continue;
    // 終了後にBUFFER_AFTER_MIN分の空きを確保する（次の予約が間髪入れずに入らないように）
    busy.push({ date: r.date, start: hmToMin(r.startTime), end: Math.min(24 * 60, hmToMin(r.endTime) + BUFFER_AFTER_MIN) });
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

