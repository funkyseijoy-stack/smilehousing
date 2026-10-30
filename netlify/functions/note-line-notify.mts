import type { Context, Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";

// スタッフが「LINEでお知らせ」を押したとき、プロライン経由でお客様のLINEに
// 「おうちノートが更新されました。」を送る。
// 仕組み：プロラインで作った「おうちノート更新のお知らせ」シナリオの
// 「外部システム連携用タグ発動用URL」（https://autosns.jp/api/call-beacon/XXXX/[[uid]]）の
// [[uid]] を、案件に登録したお客様のプロラインID（uid）に置き換えて呼び出す。
// - 発動用URLは、業者・設定タブで入力し settings/main.prolineBeaconUrl に保存（リポジトリには書かない）。
// - 送る人のプロラインIDは、案件の「おうちノート連携」タブで入力し projects/<id>.prolineUids=[{uid,name}] に保存（複数可・全員に送る。以前の prolineUid も読む）。
// - 文面はプロライン側のシナリオで設定する（このプログラムでは文面を持たない）。
// - kind:"message"（スタッフがメッセージを送ったとき・自動）は「メッセージのお知らせ」用の発動用URL
//   settings/main.prolineMsgBeaconUrl を使う（未保存なら prolineBeaconUrl＝おうちノート更新のお知らせで代用）。
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
  // 送る人：prolineUids=[{uid,name}]（以前の1人だけの prolineUid も読む）
  const list: string[] = Array.isArray(project.prolineUids)
    ? project.prolineUids.map((r: any) => String((r && r.uid) || "").trim()).filter(Boolean)
    : (project.prolineUid ? [String(project.prolineUid).trim()] : []);
  const uids = Array.from(new Set(list)).slice(0, 10);
  if (!uids.length) return json({ ok: false, error: "no_uid" }, 400);
  if (uids.some((u) => !/^[A-Za-z0-9_-]{1,64}$/.test(u))) return json({ ok: false, error: "bad_uid" }, 400);

  const settings: any = await store.get("settings/main", { type: "json" });
  const isMsg = body.kind === "message";
  const beacon = String((settings && ((isMsg && settings.prolineMsgBeaconUrl) || settings.prolineBeaconUrl)) || "").trim();
  if (!beacon) return json({ ok: false, error: "no_beacon" }, 400);
  if (!beacon.startsWith(BEACON_PREFIX) || !beacon.includes("[[uid]]")) return json({ ok: false, error: "bad_beacon" }, 400);

  const failed: string[] = [];
  for (const uid of uids) {
    try {
      const res = await fetch(beacon.replace("[[uid]]", encodeURIComponent(uid)), { method: "GET" });
      if (!res.ok) failed.push(uid);
    } catch {
      failed.push(uid);
    }
  }
  const sent = uids.length - failed.length;
  if (!sent) return json({ ok: false, error: "proline_failed", failed }, 502);
  return json({ ok: true, sent, failed, usedMsgBeacon: !!(isMsg && settings && settings.prolineMsgBeaconUrl) });
};

export const config: Config = {
  path: "/api/note-line-notify",
};
