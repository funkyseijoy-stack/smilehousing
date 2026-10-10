import type { Context, Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";
import { scryptSync, randomBytes, timingSafeEqual } from "node:crypto";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

// 他のFunctionがデータAPIの確認に使う値（ログインに成功した人へ返す）。変更する場合はすべてのFunctionで揃える。
// 個人ログイン（2026年10月〜）：ログイン画面では、この値は使わない（下の「初期設定」と「リセット」を除く）。
const STAFF_PASSPHRASE = "sumairu2026";

// 合言葉を決める人（管理者）。この人だけが、ほかのスタッフの合言葉を設定・解除できる。
const ADMIN_NAME = "朋子";
const MIN_LEN = 6;
const MAX_FAILS = 5;                 // 続けて間違えたら一時的に止める
const LOCK_MS = 10 * 60 * 1000;      // 10分

const json = (obj: any, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { ...CORS_HEADERS, "Content-Type": "application/json", "Cache-Control": "no-store" } });

const keyOf = (name: string) => "u/" + encodeURIComponent(name);
const hashOf = (pw: string, salt: string) => scryptSync(pw, salt, 32).toString("hex");
function sameHex(a: string, b: string) {
  const x = Buffer.from(a, "hex"), y = Buffer.from(b, "hex");
  return x.length === y.length && timingSafeEqual(x, y);
}
function resetCode(): string {
  try { return (Netlify.env.get("STAFF_ADMIN_RESET") || "").trim(); } catch { return ""; }
}
const cleanName = (v: any) => String(v || "").trim().slice(0, 30);

async function getCred(store: any, name: string): Promise<any> {
  return await store.get(keyOf(name), { type: "json" });
}

// 名前＋合言葉の確認。"ok" ／ "bad" ／ "locked" ／ "none"（その人の合言葉が未設定）
async function verifyCred(store: any, name: string, password: string): Promise<"ok" | "bad" | "locked" | "none"> {
  const rec = await getCred(store, name);
  if (!rec || !rec.hash) return "none";
  if (rec.lockedUntil && Date.now() < rec.lockedUntil) return "locked";
  const ok = sameHex(hashOf(password, rec.salt), rec.hash);
  if (ok) {
    if (rec.fails || rec.lockedUntil) { rec.fails = 0; rec.lockedUntil = 0; await store.setJSON(keyOf(name), rec); }
    return "ok";
  }
  rec.fails = (rec.fails || 0) + 1;
  if (rec.fails >= MAX_FAILS) { rec.lockedUntil = Date.now() + LOCK_MS; rec.fails = 0; }
  await store.setJSON(keyOf(name), rec);
  return rec.lockedUntil && Date.now() < rec.lockedUntil ? "locked" : "bad";
}

// 管理者として認められるか。管理者の合言葉が未設定の間（初期設定）は、これまでの共通の合言葉で入れる。
// 管理者が合言葉を忘れたときは、Netlifyの環境変数 STAFF_ADMIN_RESET に入れた値で入れる。
async function adminOk(store: any, password: string): Promise<{ ok: boolean; locked?: boolean; bootstrap?: boolean }> {
  const reset = resetCode();
  if (reset && password === reset) return { ok: true, bootstrap: true };
  const rec = await getCred(store, ADMIN_NAME);
  if (!rec || !rec.hash) return password === STAFF_PASSPHRASE ? { ok: true, bootstrap: true } : { ok: false };
  const r = await verifyCred(store, ADMIN_NAME, password);
  return { ok: r === "ok", locked: r === "locked" };
}

export default async (req: Request, context: Context) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
  const store = getStore("staffLogins");

  // ログイン画面用：合言葉が決まっている人の名前（と、管理者の初期設定がまだかどうか）
  if (req.method === "GET") {
    const { blobs } = await store.list({ prefix: "u/" });
    const names: string[] = [];
    for (const b of blobs) {
      const rec: any = await store.get(b.key, { type: "json" });
      if (rec && rec.hash) names.push(decodeURIComponent(b.key.slice(2)));
    }
    const bootstrap = !names.includes(ADMIN_NAME);
    if (bootstrap) names.unshift(ADMIN_NAME);
    return json({ names, admin: ADMIN_NAME, bootstrap });
  }
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  let body: any;
  try { body = await req.json(); } catch { return json({ error: "invalid_json" }, 400); }
  const action = String(body.action || "login");

  if (action === "login") {
    const name = cleanName(body.name);
    const password = String(body.password || "");
    if (!name) return json({ ok: false, error: "name_required" }, 400);
    if (!password) return json({ ok: false, error: "wrong_password" }, 401);
    if (name === ADMIN_NAME) {
      const rec = await getCred(store, ADMIN_NAME);
      const reset = resetCode();
      // 管理者の合言葉が未設定（初期設定）または忘れたとき：この場でご自分の合言葉を決めてもらう
      if (((!rec || !rec.hash) && password === STAFF_PASSPHRASE) || (reset && password === reset)) {
        return json({ ok: true, token: STAFF_PASSPHRASE, name, mustSet: true });
      }
    }
    const r = await verifyCred(store, name, password);
    if (r === "ok") return json({ ok: true, token: STAFF_PASSPHRASE, name });
    if (r === "locked") return json({ ok: false, error: "locked" }, 429);
    return json({ ok: false, error: "wrong_password" }, 401);
  }

  if (action === "setPassword" || action === "clearPassword") {
    const a = await adminOk(store, String(body.adminPassword || ""));
    if (a.locked) return json({ ok: false, error: "locked" }, 429);
    if (!a.ok) return json({ ok: false, error: "admin_wrong" }, 401);
    const name = cleanName(body.name);
    if (!name) return json({ ok: false, error: "name_required" }, 400);
    if (action === "clearPassword") {
      if (name === ADMIN_NAME) return json({ ok: false, error: "cannot_clear_admin" }, 400);
      await store.delete(keyOf(name));
      return json({ ok: true });
    }
    const pw = String(body.password || "");
    if (pw.length < MIN_LEN) return json({ ok: false, error: "too_short", min: MIN_LEN }, 400);
    if (pw === STAFF_PASSPHRASE) return json({ ok: false, error: "same_as_old" }, 400);
    const salt = randomBytes(16).toString("hex");
    await store.setJSON(keyOf(name), { salt, hash: hashOf(pw, salt), updatedAt: new Date().toISOString(), fails: 0, lockedUntil: 0 });
    return json({ ok: true });
  }

  return json({ error: "unknown_action" }, 400);
};

export const config: Config = {
  path: "/api/staff-auth",
};
