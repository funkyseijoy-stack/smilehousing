import { getStore } from "@netlify/blobs";
import webpush from "web-push";

// お客様のスマホへのプッシュ通知（おうちノート・お打合せの記録ページ、2026年11月〜）。
// - 登録した端末は "pushSubs" ストアの <案件ID>/<端末ID> に {id,projectId,page,name,url,sub,createdAt,lastOkAt,failCount,disabledAt}。
//   sub＝ブラウザの PushSubscription（endpoint・keys）。お客様の画面からは中身を返さない。
// - 送る鍵（VAPID）は "pushConfig" ストアの "vapid" に1回だけ作って保存する（環境変数は使わない）。
// - 送るのは LINE のお知らせと同じ時（netlify/lib/line-queue.mts）。届かなくなった端末（404/410）は disabledAt を付けて以後送らない。
const SUBJECT = "https://sprightly-pegasus-9b65a7.netlify.app/";
export const PUSH_MAX_PER_PROJECT = 20;

let vapidCache: { publicKey: string; privateKey: string } | null = null;
export async function getVapid() {
  if (vapidCache) return vapidCache;
  const cfg = getStore("pushConfig");
  let v: any = await cfg.get("vapid", { type: "json", consistency: "strong" } as any);
  if (!v || !v.publicKey || !v.privateKey) {
    const k = webpush.generateVAPIDKeys();
    await cfg.setJSON("vapid", { ...k, createdAt: new Date().toISOString() }, { onlyIfNew: true } as any);
    v = await cfg.get("vapid", { type: "json", consistency: "strong" } as any);
  }
  vapidCache = { publicKey: v.publicKey, privateKey: v.privateKey };
  return vapidCache;
}

export function subIdOf(endpoint: string) {
  // endpoint から短いIDを作る（同じ端末は同じID＝二重に登録しない）
  let h1 = 0x811c9dc5, h2 = 0x01000193;
  for (let i = 0; i < endpoint.length; i++) {
    const c = endpoint.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 16777619) >>> 0;
    h2 = Math.imul(h2 + c, 2654435761) >>> 0;
  }
  return "ps" + h1.toString(36) + h2.toString(36);
}

export async function listSubs(projectId: string) {
  const s = getStore("pushSubs");
  const { blobs } = await s.list({ prefix: projectId + "/" });
  const all = await Promise.all(blobs.map((b) => s.get(b.key, { type: "json", consistency: "strong" } as any).catch(() => null)));
  return all.filter(Boolean) as any[];
}
export async function listAllSubs() {
  const s = getStore("pushSubs");
  const { blobs } = await s.list();
  const all = await Promise.all(blobs.map((b) => s.get(b.key, { type: "json" }).catch(() => null)));
  return all.filter(Boolean) as any[];
}
export function isActive(x: any) { return !!(x && !x.disabledAt && x.sub && x.sub.endpoint); }
// スタッフの画面に見せる形（鍵・endpoint は出さない）
export function publicSub(x: any) {
  return { id: x.id, projectId: x.projectId, page: x.page || "note", name: x.name || "", createdAt: x.createdAt || "",
    lastOkAt: x.lastOkAt || "", disabledAt: x.disabledAt || "", disabledWhy: x.disabledWhy || "", ua: x.ua || "" };
}
export async function saveSub(doc: any) {
  await getStore("pushSubs").setJSON(`${doc.projectId}/${doc.id}`, doc);
}

// この案件の届く端末すべてに送る
export async function sendPushToProject(projectId: string, payload: { title: string; body: string }) {
  const subs = (await listSubs(projectId)).filter(isActive);
  const okIds = new Set<string>();
  if (!subs.length) return { sent: 0, failed: 0, total: 0, okIds };
  const v = await getVapid();
  webpush.setVapidDetails(SUBJECT, v.publicKey, v.privateKey);
  let sent = 0, failed = 0;
  const now = new Date().toISOString();
  await Promise.all(subs.map(async (x) => {
    const title = x.page === "kiroku" ? "お打合せの記録" : (payload.title || "おうちノート");
    const body = x.page === "kiroku" ? "お打合せの記録が更新されました。" : payload.body;
    try {
      await webpush.sendNotification(x.sub, JSON.stringify({ title, body, url: x.url || "/" }), { TTL: 60 * 60 * 24 * 3, urgency: "normal" } as any);
      sent++; okIds.add(String(x.id));
      x.lastOkAt = now; x.failCount = 0;
      await saveSub(x);
    } catch (e: any) {
      failed++;
      const code = e && e.statusCode;
      x.failCount = (x.failCount || 0) + 1;
      x.lastError = String((e && (e.body || e.message)) || "").slice(0, 200);
      // 404/410＝お客様が通知を切った・アプリを消した。何度も失敗する端末も止める
      if (code === 404 || code === 410 || x.failCount >= 5) { x.disabledAt = now; x.disabledWhy = code === 404 || code === 410 ? "gone" : "errors"; }
      await saveSub(x);
    }
  }));
  return { sent, failed, total: subs.length, okIds };
}
