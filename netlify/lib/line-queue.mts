import { getStore } from "@netlify/blobs";

// お客様へのLINEのお知らせ（プロライン経由）を、時間帯でまとめて送る。
// - 夜（20:00〜翌10:00、日本時間）に頼まれた分は、朝10:00に1回だけ送る（同じお客様へ何人が何回頼んでも1回）。
// - 昼（10:00〜20:00）は、同じお客様へ前に送ってから30分たっていればすぐ送り、30分以内なら
//   「前回＋30分」に1回だけ送る（その間に頼まれた分はまとめる）。
// - たまった分は line-queue-flush.mts（5分おきの定期関数）が送る。
// 状態は "lineQueue" ストアの <案件ID> に {projectId,lastSentAt,lastSentBy,pending:{sendAt,firstAt,kinds,by}}。
export const NIGHT_START_MIN = 20 * 60; // 20:00
export const MORNING_MIN = 10 * 60;     // 10:00
export const GAP_MS = 30 * 60 * 1000;   // 30分
const BEACON_PREFIX = "https://autosns.jp/api/call-beacon/";
const JST = 9 * 60 * 60 * 1000;

export function jstMinutes(ms: number) {
  const d = new Date(ms + JST);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}
// 次の朝10:00（日本時間）のUTCミリ秒
export function nextMorning(ms: number) {
  const d = new Date(ms + JST);
  let t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 10, 0, 0) - JST;
  if (t <= ms) t += 24 * 60 * 60 * 1000;
  return t;
}
export function isNight(ms: number) {
  const m = jstMinutes(ms);
  return m < MORNING_MIN || m >= NIGHT_START_MIN;
}
export function jstLabel(ms: number) {
  const d = new Date(ms + JST);
  const now = new Date(Date.now() + JST);
  const sameDay = d.getUTCDate() === now.getUTCDate() && d.getUTCMonth() === now.getUTCMonth();
  const hm = d.getUTCHours() + ":" + String(d.getUTCMinutes()).padStart(2, "0");
  return (sameDay ? "" : "明日") + hm;
}

export function recipientsOf(project: any): string[] {
  const list: string[] = Array.isArray(project && project.prolineUids)
    ? project.prolineUids.map((r: any) => String((r && r.uid) || "").trim()).filter(Boolean)
    : (project && project.prolineUid ? [String(project.prolineUid).trim()] : []);
  return Array.from(new Set(list)).slice(0, 10);
}
export function checkBeacon(settings: any): string | null {
  const beacon = String((settings && settings.prolineBeaconUrl) || "").trim();
  if (!beacon || !beacon.startsWith(BEACON_PREFIX) || !beacon.includes("[[uid]]")) return null;
  return beacon;
}
export async function sendBeacon(beacon: string, uids: string[]) {
  const failed: string[] = [];
  for (const uid of uids) {
    try {
      const res = await fetch(beacon.replace("[[uid]]", encodeURIComponent(uid)), { method: "GET" });
      if (!res.ok) failed.push(uid);
    } catch { failed.push(uid); }
  }
  return { sent: uids.length - failed.length, failed };
}

// 頼まれたときに呼ぶ。すぐ送るか、まとめて送る予定に入れるかを決める。
export async function requestLineNotify(opts: { projectId: string; kind: string; by: string; beacon: string; uids: string[] }) {
  const q = getStore("lineQueue");
  const now = Date.now();
  const cur: any = (await q.get(opts.projectId, { type: "json", consistency: "strong" } as any)) || { projectId: opts.projectId };
  const merge = (p: any) => {
    p.kinds = Array.from(new Set([...(p.kinds || []), opts.kind || "manual"]));
    p.by = Array.from(new Set([...(p.by || []), opts.by || ""].filter(Boolean)));
    return p;
  };
  if (cur.pending && cur.pending.sendAt) {
    cur.pending = merge(cur.pending);
    await q.setJSON(opts.projectId, cur);
    return { queued: true, sendAt: cur.pending.sendAt };
  }
  let sendAt = 0;
  if (isNight(now)) sendAt = nextMorning(now);
  else if (cur.lastSentAt && now - Date.parse(cur.lastSentAt) < GAP_MS) sendAt = Date.parse(cur.lastSentAt) + GAP_MS;
  if (sendAt && isNight(sendAt)) sendAt = nextMorning(sendAt);
  if (sendAt) {
    cur.pending = merge({ sendAt: new Date(sendAt).toISOString(), firstAt: new Date(now).toISOString() });
    await q.setJSON(opts.projectId, cur);
    return { queued: true, sendAt: cur.pending.sendAt };
  }
  const r = await sendBeacon(opts.beacon, opts.uids);
  if (r.sent) {
    cur.lastSentAt = new Date(now).toISOString();
    cur.lastSentBy = opts.by || "";
    await q.setJSON(opts.projectId, cur);
  }
  return { queued: false, ...r };
}

// 定期関数から呼ぶ。送る時刻が来た分を送る。
export async function flushLineQueue() {
  const q = getStore("lineQueue");
  const store = getStore("staffData");
  const now = Date.now();
  const { blobs } = await q.list();
  if (!blobs.length) return { sent: 0 };
  const settings: any = await store.get("settings/main", { type: "json" });
  const beacon = checkBeacon(settings);
  let sentCount = 0;
  for (const b of blobs) {
    const cur: any = await q.get(b.key, { type: "json", consistency: "strong" } as any);
    if (!cur || !cur.pending || !cur.pending.sendAt) continue;
    if (Date.parse(cur.pending.sendAt) > now) continue;
    // 昼に予約した分でも、送る時刻が夜（20時以降）にずれ込んだら、翌朝10時へ回す
    if (isNight(now)) { cur.pending.sendAt = new Date(nextMorning(now)).toISOString(); await q.setJSON(b.key, cur); continue; }
    const project: any = await store.get(`projects/${b.key}`, { type: "json" });
    const uids = recipientsOf(project);
    if (!project || project.deletedAt || !uids.length || !beacon) { delete cur.pending; await q.setJSON(b.key, cur); continue; }
    const r = await sendBeacon(beacon, uids);
    cur.lastSentAt = new Date(now).toISOString();
    cur.lastSentBy = (cur.pending.by || []).join("、");
    cur.lastResult = { sent: r.sent, failed: r.failed, kinds: cur.pending.kinds || [] };
    delete cur.pending;
    await q.setJSON(b.key, cur);
    sentCount += r.sent ? 1 : 0;
  }
  return { sent: sentCount };
}
