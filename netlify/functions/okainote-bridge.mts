import type { Context, Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";
import { getExtras, saveExtras, EXTRAS_KEYS } from "../lib/note-extras.mts";

// 住まいるアプリの「おうちノート連携」タブ（追加見積り・家づくりリスト・ご家族・家電・
// A's 3Dリンク）の保存先。以前は旧おうちノート本体につないでいたが、今は住まいるアプリ
// 本体のデータ置き場（noteExtras）に保存する（旧側からは最初の1回だけ自動で写す）。
// URL・応答の形は従来のまま（画面側の変更を少なくするため、関数名もそのまま）。

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PATCH, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Staff-Token",
};

// staff-data.mts と同じ合い言葉（住まいるアプリ内の認証）
const STAFF_PASSPHRASE = "sumairu2026";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

function sanitizeCustomerId(value: string): string {
  return String(value || "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 80);
}

export default async (req: Request, context: Context) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (req.headers.get("x-staff-token") !== STAFF_PASSPHRASE) return json({ error: "unauthorized" }, 401);

  const store = getStore("staffData");
  const url = new URL(req.url);

  if (req.method === "GET") {
    const projectId = sanitizeCustomerId(url.searchParams.get("projectId") || "");
    const resource = url.searchParams.get("resource") || "data";
    if (!projectId) return json({ error: "projectId_required" }, 400);
    if (resource === "inbox") return json({ entries: [] });
    if (resource !== "data") return json({ error: "unknown_resource" }, 400);
    const doc = await getExtras(store, projectId);
    if (!doc) return json({ error: "okainote_unavailable" }, 502);
    return json({ customer: doc, link: null });
  }

  let body: any = {};
  try { body = await req.json(); } catch { return json({ error: "invalid_json" }, 400); }
  const projectId = sanitizeCustomerId(body.projectId || "");

  if (req.method === "PATCH") {
    if (!projectId) return json({ error: "projectId_required" }, 400);
    const patch = body.patch;
    if (!patch || typeof patch !== "object") return json({ error: "patch_required" }, 400);
    const doc = await getExtras(store, projectId);
    if (!doc) return json({ error: "okainote_unavailable" }, 502); // 旧側のデータをまだ写せていない間は書き込まない
    for (const k of EXTRAS_KEYS) {
      if (patch[k] === undefined) continue;
      if (k === "customerLinks" && patch[k] && typeof patch[k] === "object") doc[k] = { ...(doc[k] || {}), ...patch[k] };
      else doc[k] = patch[k];
    }
    await saveExtras(store, doc);
    return json({ customer: doc });
  }

  if (req.method === "POST") {
    // 旧おうちノート向けの操作は廃止（画面側からは呼ばれない）
    if (body.action === "ensureLink") return json({ error: "retired" }, 410);
    if (["markInboxRead", "postInboxEntry", "deleteInboxEntry"].includes(body.action)) return json({ ok: true });
    return json({ error: "unknown_action" }, 400);
  }

  return json({ error: "method_not_allowed" }, 405);
};

export const config: Config = {
  path: "/api/okainote-bridge",
};
