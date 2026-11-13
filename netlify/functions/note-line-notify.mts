import type { Context, Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";
import { requestLineNotify, recipientsOf, jstLabel, activePushIds, projectForSend } from "../lib/line-queue.mts";

// スタッフが「LINEでお知らせ」を押したとき、プロライン経由でお客様のLINEに
// 「おうちノートが更新されました。」を送る。
// 仕組み：プロラインで作った「おうちノート更新のお知らせ」シナリオの
// 「外部システム連携用タグ発動用URL」（https://autosns.jp/api/call-beacon/XXXX/[[uid]]）の
// [[uid]] を、案件に登録したお客様のプロラインID（uid）に置き換えて呼び出す。
// - 発動用URLは、業者・設定タブで入力し settings/main.prolineBeaconUrl に保存（リポジトリには書かない）。
// - 送る人のプロラインIDは、案件の「おうちノート連携」タブで入力し projects/<id>.prolineUids=[{uid,name}] に保存（複数可・全員に送る。以前の prolineUid も読む）。
// - 文面はプロライン側のシナリオで設定する（このプログラムでは文面を持たない）。
// - kind:"message" はスタッフがメッセージを送ったときの自動のお知らせ（文面は同じ「おうちノートが更新されました。」）。
// - 送る時間（2026年11月〜）：夜（20:00〜翌10:00）に頼まれた分は朝10:00に1回だけ、昼は同じお客様へ30分に1回まで
//   （netlify/lib/line-queue.mts、まとめた分は line-queue-flush.mts が送る）。予定に入れたときは {ok:true, queued:true, sendAt, sendAtLabel}。
// - プッシュ通知（2026年11月〜）：お客様が登録した端末にも同じ時に送る（netlify/lib/push.mts）。LINEの送る人が0人でも、
//   届く端末があれば送れる。行に pushSub が付いた人は、その端末に届く間はLINEを送らない。
// 認証は他の機能と同じ合言葉（X-Staff-Token）。
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Staff-Token",
};
// staff-auth.mts と同じ値にしてください。
const STAFF_PASSPHRASE = "sumairu2026";
const BEACON_PREFIX = "https://autosns.jp/api/call-beacon/";

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
  const projectId = String(body.projectId || "");
  if (!projectId) return json({ error: "missing_fields" }, 400);

  const store = getStore("staffData");
  const project: any = await store.get(`projects/${projectId}`, { type: "json" });
  if (!project || project.deletedAt) return json({ error: "not_found" }, 404);
  // 送る人：prolineUids=[{uid,name,pushSub}]（以前の1人だけの prolineUid も読む）。プッシュ通知で届く人は除く
  const act = await activePushIds(projectId);
  const allUids = recipientsOf(project);
  if (allUids.some((u) => !/^[A-Za-z0-9_-]{1,64}$/.test(u))) return json({ ok: false, error: "bad_uid" }, 400);
  const uids = recipientsOf(await projectForSend({ ...project, id: projectId }), act);
  const settings: any = await store.get("settings/main", { type: "json" });
  const beaconRaw = String((settings && settings.prolineBeaconUrl) || "").trim();
  const beaconOk = !!beaconRaw && beaconRaw.startsWith(BEACON_PREFIX) && beaconRaw.includes("[[uid]]");
  const beacon = beaconOk ? beaconRaw : null;
  if (!act.size) {
    if (!uids.length) return json({ ok: false, error: "no_uid" }, 400);
    if (!beaconRaw) return json({ ok: false, error: "no_beacon" }, 400);
    if (!beaconOk) return json({ ok: false, error: "bad_beacon" }, 400);
  }

  const r: any = await requestLineNotify({ projectId, kind: String(body.kind || "manual"), by: String(body.by || ""), beacon });
  if (r.queued) return json({ ok: true, queued: true, sendAt: r.sendAt, sendAtLabel: jstLabel(Date.parse(r.sendAt)), push: act.size, line: uids.length });
  if (!r.sent && !r.pushSent) return json({ ok: false, error: act.size ? "push_failed" : "proline_failed", failed: r.failed }, 502);
  return json({ ok: true, sent: r.sent, failed: r.failed, pushSent: r.pushSent, pushTotal: r.pushTotal, lineTo: r.lineTo || [], pushTo: r.pushTo || [] });
};

export const config: Config = {
  path: "/api/note-line-notify",
};
