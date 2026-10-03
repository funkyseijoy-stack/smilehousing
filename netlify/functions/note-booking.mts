import type { Context, Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";

// おうちノート（/note/）の「予約」タブから、お客様がその場で日時を選んで
// 打合せ予約を取れるようにするAPI。旧おうちノート（strong-piroshki）にあった
// 自己予約機能を、このリポジトリ内に作り直したもの。
//
// 空き状況は、会社の共有Googleカレンダーの中の「お客様予約」という名前のカレンダーを見て判定する
// （スタッフ全員の打合せ予定がそこにまとまって入っている運用のため）。
// 予約が成立すると、そのカレンダーに予定を作成し、あわせて住まいるアプリの
// reservations コレクションにも保存する（住まいるアプリの「予約」タブ・おうちノートの
// 予約一覧・ホームの「次回のご予約」にそのまま反映される）。
//
// 認証は note-data.mts と同じ、案件ごとの noteToken 方式。

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

function genId(prefix: string) {
  return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 9);
}

// ================= 予約ルール（旧おうちノートと同じ内容で固定） =================
const RESERVATION_TYPES = ["来店", "オンライン", "銀行", "ショールーム"];
const DURATION_MIN = 120; // 旧おうちノートはどの種別も2時間固定
const OPEN_MIN = 9 * 60; // 9:00
const CLOSE_MIN = 17 * 60; // 17:00（最終退出目安。最終受付は後述の LAST_START_MIN）
const LAST_START_MIN = 15 * 60; // 最終受付 15:00
const SLOT_STEP_MIN = 30;
const BOOKING_CALENDAR_SUMMARY = "お客様予約";
const MAX_RANGE_DAYS = 31; // 一度に問い合わせられる日数の上限（負荷対策）

function pad2(n: number) {
  return n < 10 ? "0" + n : String(n);
}
function hhmmOf(totalMin: number) {
  return pad2(Math.floor(totalMin / 60)) + ":" + pad2(totalMin % 60);
}
function parseHHMM(s: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || ""));
  if (!m) return null;
  const h = parseInt(m[1], 10), mi = parseInt(m[2], 10);
  if (h < 0 || h > 23 || mi < 0 || mi > 59) return null;
  return h * 60 + mi;
}
function isValidDateStr(s: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(s || ""));
}
function addDays(dateStr: string, n: number) {
  const d = new Date(dateStr + "T00:00:00+09:00");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// ================= 日本の祝日判定（2000〜2099年、概算） =================
// 春分・秋分の日は天文計算に基づく近似式（広く使われているもの）。
// 「国民の休日」（祝日に挟まれた平日）・振替休日（祝日が日曜の場合、直後の平日を休日に）も考慮する。
function vernalEquinoxDay(year: number) {
  return Math.floor(20.8431 + 0.242194 * (year - 1980) - Math.floor((year - 1980) / 4));
}
function autumnalEquinoxDay(year: number) {
  return Math.floor(23.2488 + 0.242194 * (year - 1980) - Math.floor((year - 1980) / 4));
}
// year年month月の第n月曜日の「日」を返す
function nthMonday(year: number, month: number, n: number) {
  const first = new Date(Date.UTC(year, month - 1, 1));
  const firstDow = first.getUTCDay(); // 0=日
  const firstMonday = 1 + ((8 - firstDow) % 7 === 7 ? 0 : (8 - firstDow) % 7);
  // 上の式は複雑なので素直に計算し直す
  let day = 1;
  while (new Date(Date.UTC(year, month - 1, day)).getUTCDay() !== 1) day++;
  return day + (n - 1) * 7;
}
function fixedHolidaysOf(year: number): { month: number; day: number; name: string }[] {
  const list = [
    { month: 1, day: 1, name: "元日" },
    { month: 2, day: 11, name: "建国記念の日" },
    { month: 4, day: 29, name: "昭和の日" },
    { month: 5, day: 3, name: "憲法記念日" },
    { month: 5, day: 4, name: "みどりの日" },
    { month: 5, day: 5, name: "こどもの日" },
    { month: 11, day: 3, name: "文化の日" },
    { month: 11, day: 23, name: "勤労感謝の日" },
    { month: 1, day: nthMonday(year, 1, 2), name: "成人の日" },
    { month: 7, day: nthMonday(year, 7, 3), name: "海の日" },
    { month: 9, day: nthMonday(year, 9, 3), name: "敬老の日" },
    { month: 10, day: nthMonday(year, 10, 2), name: "スポーツの日" },
    { month: 3, day: vernalEquinoxDay(year), name: "春分の日" },
    { month: 9, day: autumnalEquinoxDay(year), name: "秋分の日" },
  ];
  if (year >= 2020) list.push({ month: 2, day: 23, name: "天皇誕生日" });
  if (year >= 2016) list.push({ month: 8, day: 11, name: "山の日" });
  return list;
}
function isJapaneseHoliday(dateStr: string): boolean {
  const d = new Date(dateStr + "T00:00:00+09:00");
  const year = d.getUTCFullYear();
  const dateSet = new Set<string>();
  const mk = (y: number, m: number, day: number) => y + "-" + pad2(m) + "-" + pad2(day);
  for (const y of [year - 1, year, year + 1]) {
    for (const h of fixedHolidaysOf(y)) dateSet.add(mk(y, h.month, h.day));
  }
  // 振替休日：祝日が日曜なら、その直後で祝日でない最初の平日を休日にする
  const substitutes = new Set<string>();
  dateSet.forEach((ds) => {
    const dow = new Date(ds + "T00:00:00+09:00").getUTCDay();
    if (dow === 0) {
      let next = addDays(ds, 1);
      while (dateSet.has(next) || substitutes.has(next)) next = addDays(next, 1);
      substitutes.add(next);
    }
  });
  substitutes.forEach((s) => dateSet.add(s));
  // 国民の休日：前後を祝日に挟まれた平日
  const nationalHolidays = new Set<string>();
  dateSet.forEach((ds) => {
    const before = addDays(ds, -1);
    const after = addDays(ds, 1);
    if (dateSet.has(after) && !dateSet.has(after + "__skip")) {
      // ds の翌日も祝日なら、ds と翌日の「間」は無いので何もしない（連続祝日）
    }
  });
  // 間に挟まれた1日だけのケースを素直に走査
  for (let i = -3; i <= 3; i++) {
    const cur = addDays(dateStr, i);
    const prev = addDays(cur, -1);
    const next = addDays(cur, 1);
    if (!dateSet.has(cur) && dateSet.has(prev) && dateSet.has(next)) {
      nationalHolidays.add(cur);
    }
  }
  nationalHolidays.forEach((s) => dateSet.add(s));
  return dateSet.has(dateStr);
}
function isClosedDay(dateStr: string): boolean {
  const dow = new Date(dateStr + "T00:00:00+09:00").getUTCDay();
  if (dow === 0) return true; // 日曜定休
  if (isJapaneseHoliday(dateStr)) return true;
  return false;
}

// ================= Google OAuth / Calendar API =================
async function getAccessToken(): Promise<{ ok: true; accessToken: string } | { ok: false; error: string }> {
  const clientId = Netlify.env.get("GOOGLE_CLIENT_ID");
  const clientSecret = Netlify.env.get("GOOGLE_CLIENT_SECRET");
  if (!clientId || !clientSecret) return { ok: false, error: "server_not_configured" };

  const store = getStore("googleAuth");
  const data: any = await store.get("gmail", { type: "json" });
  if (!data || !data.refresh_token) return { ok: false, error: "google_not_connected" };

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

// 「お客様予約」という名前のカレンダーのIDを探す。見つからなければ null。
async function findBookingCalendarId(accessToken: string): Promise<string | null> {
  const res = await fetch("https://www.googleapis.com/calendar/v3/users/me/calendarList?maxResults=250", {
    headers: { Authorization: "Bearer " + accessToken },
  });
  if (!res.ok) return null;
  const data: any = await res.json();
  const items: any[] = data.items || [];
  const hit = items.find((it) => String(it.summary || "").trim() === BOOKING_CALENDAR_SUMMARY);
  return hit ? hit.id : null;
}

// 指定した日付範囲（JST）の、そのカレンダー上の busy 時間帯一覧を取得
async function fetchBusy(accessToken: string, calendarId: string, fromDateStr: string, toDateStr: string) {
  const timeMin = fromDateStr + "T00:00:00+09:00";
  const timeMax = toDateStr + "T23:59:59+09:00";
  const res = await fetch("https://www.googleapis.com/calendar/v3/freeBusy", {
    method: "POST",
    headers: { Authorization: "Bearer " + accessToken, "Content-Type": "application/json" },
    body: JSON.stringify({ timeMin, timeMax, items: [{ id: calendarId }] }),
  });
  if (!res.ok) throw new Error("freebusy_failed");
  const data: any = await res.json();
  const cal = data.calendars && data.calendars[calendarId];
  if (!cal) throw new Error("calendar_not_in_response");
  if (cal.errors && cal.errors.length) throw new Error("freebusy_error:" + JSON.stringify(cal.errors));
  return (cal.busy || []) as { start: string; end: string }[];
}

function openSlotsForDay(dateStr: string, busy: { start: string; end: string }[], durationMin: number): string[] {
  if (isClosedDay(dateStr)) return [];
  const out: string[] = [];
  for (let m = OPEN_MIN; m <= LAST_START_MIN; m += SLOT_STEP_MIN) {
    const slotStart = new Date(dateStr + "T" + hhmmOf(m) + ":00+09:00");
    const slotEnd = new Date(slotStart.getTime() + durationMin * 60000);
    // 営業終了時刻を超える枠は出さない
    if (slotEnd.getTime() > new Date(dateStr + "T" + hhmmOf(CLOSE_MIN) + ":00+09:00").getTime()) continue;
    const overlap = busy.some((b) => new Date(b.start).getTime() < slotEnd.getTime() && new Date(b.end).getTime() > slotStart.getTime());
    if (!overlap) out.push(hhmmOf(m));
  }
  return out;
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
  if (!project) return json({ error: "project_not_found" }, 403);
  if (project.deletedAt) return json({ error: "project_deleted" }, 403);
  if (!project.noteToken || project.noteToken !== token) return json({ error: "token_mismatch" }, 403);

  const tokenResult = await getAccessToken();
  if (!tokenResult.ok) {
    return json({ error: tokenResult.error, message: "現在ご予約の空き状況を確認できません。しばらくしてから再度お試しいただくか、メッセージでお問い合わせください。" }, 503);
  }
  const calendarId = await findBookingCalendarId(tokenResult.accessToken);
  if (!calendarId) {
    return json({ error: "booking_calendar_not_found", message: "予約カレンダーの設定を確認中です。メッセージでお問い合わせください。" }, 503);
  }

  // ---------- GET: 空き状況の取得 ----------
  if (req.method === "GET") {
    const action = url.searchParams.get("action") || "";
    const type = url.searchParams.get("type") || "";

    if (action === "days") {
      let from = url.searchParams.get("from") || new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
      let to = url.searchParams.get("to") || addDays(from, 6);
      if (!isValidDateStr(from) || !isValidDateStr(to)) return json({ error: "invalid_range" }, 400);
      if (new Date(to).getTime() - new Date(from).getTime() > MAX_RANGE_DAYS * 86400000) {
        to = addDays(from, MAX_RANGE_DAYS);
      }
      try {
        const busy = await fetchBusy(tokenResult.accessToken, calendarId, from, to);
        const days: { date: string; closed: boolean; hasOpenSlots: boolean }[] = [];
        let cur = from;
        while (cur <= to) {
          const closed = isClosedDay(cur);
          const slots = closed ? [] : openSlotsForDay(cur, busy, DURATION_MIN);
          days.push({ date: cur, closed, hasOpenSlots: slots.length > 0 });
          cur = addDays(cur, 1);
        }
        return json({ ok: true, days });
      } catch (e: any) {
        return json({ error: "calendar_query_failed", message: String(e?.message || e) }, 502);
      }
    }

    if (action === "slots") {
      const date = url.searchParams.get("date") || "";
      if (!isValidDateStr(date)) return json({ error: "invalid_date" }, 400);
      try {
        const busy = await fetchBusy(tokenResult.accessToken, calendarId, date, date);
        const slots = openSlotsForDay(date, busy, DURATION_MIN);
        return json({ ok: true, date, closed: isClosedDay(date), slots, durationMin: DURATION_MIN });
      } catch (e: any) {
        return json({ error: "calendar_query_failed", message: String(e?.message || e) }, 502);
      }
    }

    return json({ error: "unknown_action" }, 400);
  }

  // ---------- POST: 予約を確定する ----------
  if (body.action === "book") {
    const type = String(body.type || "");
    const date = String(body.date || "");
    const startTime = String(body.startTime || "");
    if (!RESERVATION_TYPES.includes(type)) return json({ error: "invalid_type" }, 400);
    if (!isValidDateStr(date)) return json({ error: "invalid_date" }, 400);
    const startMin = parseHHMM(startTime);
    if (startMin == null || startMin < OPEN_MIN || startMin > LAST_START_MIN || (startMin - OPEN_MIN) % SLOT_STEP_MIN !== 0) {
      return json({ error: "invalid_time" }, 400);
    }
    if (isClosedDay(date)) return json({ error: "closed_day", message: "その日はご予約いただけません。" }, 400);

    // 二重予約を避けるため、直前にもう一度空き状況を確認する
    let busy: { start: string; end: string }[];
    try {
      busy = await fetchBusy(tokenResult.accessToken, calendarId, date, date);
    } catch (e: any) {
      return json({ error: "calendar_query_failed", message: String(e?.message || e) }, 502);
    }
    const stillOpen = openSlotsForDay(date, busy, DURATION_MIN).includes(startTime);
    if (!stillOpen) {
      return json({ error: "slot_taken", message: "その時間はちょうど埋まってしまいました。別の時間をお選びください。" }, 409);
    }

    const startISO = date + "T" + startTime + ":00+09:00";
    const endISO = new Date(new Date(startISO).getTime() + DURATION_MIN * 60000).toISOString();
    const customerName = project.customer || project.name || "お客様";

    // Googleカレンダーに予定を作成
    const evRes = await fetch(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`, {
      method: "POST",
      headers: { Authorization: "Bearer " + tokenResult.accessToken, "Content-Type": "application/json" },
      body: JSON.stringify({
        summary: customerName + "様　" + type,
        description: "おうちノートからのご予約です。\n案件：" + (project.name || ""),
        start: { dateTime: startISO, timeZone: "Asia/Tokyo" },
        end: { dateTime: endISO, timeZone: "Asia/Tokyo" },
      }),
    });
    if (!evRes.ok) {
      const errBody = await evRes.text().catch(() => "");
      return json({ error: "calendar_event_failed", message: errBody.slice(0, 500) }, 502);
    }
    const ev: any = await evRes.json();

    const id = genId("resv");
    const now = new Date().toISOString();
    const endTime = hhmmOf(startMin + DURATION_MIN);
    const doc = {
      id, projectId, type, date, startTime, endTime, staff: "",
      source: "note", googleEventId: ev.id || "",
      createdAt: now, updatedAt: now,
    };
    await store.setJSON(`reservations/${id}`, doc);

    return json({ ok: true, reservation: doc });
  }

  return json({ error: "unknown_action" }, 400);
};

export const config: Config = {
  path: "/api/note-booking",
};
