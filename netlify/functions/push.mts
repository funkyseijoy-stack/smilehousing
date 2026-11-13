import type { Context, Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";
import webpush from "web-push";
import { getVapid, subIdOf, listSubs, listAllSubs, publicSub, saveSub, isActive, PUSH_MAX_PER_PROJECT } from "../lib/push.mts";

// お客様のスマホへのプッシュ通知の登録（/api/push、2026年11月〜）。送るのは netlify/lib/line-queue.mts（LINEのお知らせと同じ時）。
// お客様（おうちノート /note/・お打合せの記録ページ /kiroku/、案件ID p と noteToken か earlyToken t で確認）：
//   GET ?p&t → {publicKey}／POST {action:"subscribe", sub, name, page, url}／{action:"unsubscribe", endpoint}／{action:"status", endpoint}
// スタッフ（X-Staff-Token に合言葉）：GET → {subs:[…]}（全案件、鍵は返さない）
//   POST {action:"rename"|"remove"|"test", projectId, id, name}
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Staff-Token",
};
// staff-auth.mts と同じ値にしてください。
const STAFF_PASSPHRASE = "sumairu2026";

function json(obj: any, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { ...CORS_HEADERS, "Content-Type": "application/json", "Cache-Control": "no-store" } });
}
function cleanName(s: any) { return String(s || "").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 30); }

export default async (req: Request, context: Context) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
  const url = new URL(req.url);
  const staff = req.headers.get("x-staff-token") === STAFF_PASSPHRASE;
  let body: any = null;
  if (req.method === "POST") { try { body = await req.json(); } catch { return json({ error: "invalid_json" }, 400); } }
  else if (req.method !== "GET") return json({ error: "method_not_allowed" }, 405);

  // ---- スタッフ ----
  if (staff && !(body && body.p) && !url.searchParams.get("p")) {
    if (req.method === "GET") {
      const subs = (await listAllSubs()).map(publicSub);
      return json({ ok: true, subs });
    }
    const pid = String(body.projectId || ""), id = String(body.id || "");
    if (!pid || !id || pid.includes("/") || id.includes("/")) return json({ error: "missing_fields" }, 400);
    const s = getStore("pushSubs");
    const doc: any = await s.get(`${pid}/${id}`, { type: "json", consistency: "strong" } as any);
    if (!doc) return json({ error: "not_found" }, 404);
    if (body.action === "rename") { doc.name = cleanName(body.name); await saveSub(doc); return json({ ok: true, sub: publicSub(doc) }); }
    if (body.action === "remove") { doc.disabledAt = new Date().toISOString(); doc.disabledWhy = "staff"; await saveSub(doc); return json({ ok: true, sub: publicSub(doc) }); }
    if (body.action === "test") {
      if (!isActive(doc)) return json({ ok: false, error: "inactive" }, 400);
      const v = await getVapid();
      webpush.setVapidDetails("https://sprightly-pegasus-9b65a7.netlify.app/", v.publicKey, v.privateKey);
      try {
        await webpush.sendNotification(doc.sub, JSON.stringify({ title: doc.page === "kiroku" ? "お打合せの記録" : "おうちノート", body: "通知のテストです。届いていれば設定は完了です。", url: doc.url || "/" }), { TTL: 3600 } as any);
        doc.lastOkAt = new Date().toISOString(); doc.failCount = 0; await saveSub(doc);
        return json({ ok: true });
      } catch (e: any) {
        const code = e && e.statusCode;
        if (code === 404 || code === 410) { doc.disabledAt = new Date().toISOString(); doc.disabledWhy = "gone"; await saveSub(doc); }
        return json({ ok: false, error: code === 404 || code === 410 ? "gone" : "send_failed" }, 502);
      }
    }
    return json({ error: "unknown_action" }, 400);
  }

  // ---- お客様 ----
  const projectId = String((body ? body.p : url.searchParams.get("p")) || "");
  const token = String((body ? body.t : url.searchParams.get("t")) || "");
  if (!projectId || !token || projectId.includes("/")) return json({ error: "missing_link" }, 400);
  const project: any = await getStore("staffData").get(`projects/${projectId}`, { type: "json" });
  if (!project || project.deletedAt || !((project.noteToken && project.noteToken === token) || (project.earlyToken && project.earlyToken === token))) {
    return json({ error: "invalid_link" }, 403);
  }
  if (req.method === "GET") {
    const v = await getVapid();
    return json({ ok: true, publicKey: v.publicKey });
  }
  const endpoint = String((body.sub && body.sub.endpoint) || body.endpoint || "");
  if (!/^https:\/\//.test(endpoint) || endpoint.length > 1000) return json({ error: "bad_endpoint" }, 400);
  const id = subIdOf(endpoint);
  const s = getStore("pushSubs");
  const key = `${projectId}/${id}`;
  const cur: any = await s.get(key, { type: "json", consistency: "strong" } as any);
  if (body.action === "status") {
    return json({ ok: true, registered: isActive(cur), name: cur ? cur.name || "" : "" });
  }
  if (body.action === "unsubscribe") {
    if (cur && !cur.disabledAt) { cur.disabledAt = new Date().toISOString(); cur.disabledWhy = "customer"; await saveSub(cur); }
    return json({ ok: true });
  }
  if (body.action !== "subscribe") return json({ error: "unknown_action" }, 400);
  const keys = body.sub && body.sub.keys;
  if (!keys || typeof keys.p256dh !== "string" || typeof keys.auth !== "string" || keys.p256dh.length > 200 || keys.auth.length > 100) return json({ error: "bad_keys" }, 400);
  const page = body.page === "kiroku" ? "kiroku" : "note";
  if (!cur || !isActive(cur)) {
    const active = (await listSubs(projectId)).filter(isActive);
    if (active.length >= PUSH_MAX_PER_PROJECT) return json({ error: "limit_reached" }, 429);
  }
  const now = new Date().toISOString();
  const doc: any = {
    ...(cur || {}),
    id, projectId, page,
    name: cleanName(body.name) || (cur && cur.name) || "",
    url: `/${page}/?p=${encodeURIComponent(projectId)}&t=${encodeURIComponent(token)}`,
    sub: { endpoint, keys: { p256dh: keys.p256dh, auth: keys.auth } },
    ua: String(req.headers.get("user-agent") || "").slice(0, 200),
    createdAt: (cur && cur.createdAt) || now, updatedAt: now, failCount: 0,
  };
  delete doc.disabledAt; delete doc.disabledWhy;
  await saveSub(doc);
  return json({ ok: true, id, name: doc.name });
};

export const config: Config = {
  path: "/api/push",
};
