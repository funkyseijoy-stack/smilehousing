import type { Context, Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";

// 旧おうちノートからの引っ越し状況を調べるだけの確認用API（何も書き換えない・旧側も消さない）。
// 案件ごとに、旧側のデータ件数と、新しい側（noteExtras）に写し済みかを返す。
const OLD_BASE = "https://strong-piroshki-295252.netlify.app";
const STAFF_PASSPHRASE = "sumairu2026"; // 住まいるアプリ内の他Functionと同じ合言葉（変更時は全ファイルで揃えること）
const KEYS = ["customerEstimates", "considerations", "customerProfile", "customerLinks", "nextBookings"];

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

function count(v: any): number {
  if (Array.isArray(v)) return v.length;
  if (v && typeof v === "object") return Object.values(v).filter((x) => x !== "" && x != null && !(Array.isArray(x) && !x.length)).length;
  return 0;
}

function summarize(doc: any) {
  const o: Record<string, number> = {};
  for (const k of KEYS) o[k] = count(doc ? doc[k] : null);
  return o;
}

export default async (req: Request, _context: Context) => {
  if (req.headers.get("x-staff-token") !== STAFF_PASSPHRASE) return json({ error: "unauthorized" }, 401);
  const store = getStore("staffData");
  const { blobs } = await store.list({ prefix: "projects/" });
  const projects = (await Promise.all(blobs.map((b) => store.get(b.key, { type: "json" })))).filter((p: any) => p && !p.deletedAt) as any[];

  const rows = await Promise.all(projects.map(async (p) => {
    const id = String(p.id);
    const row: any = { id, customer: p.customer || "", name: p.name || "", old: null, oldStatus: "", now: null, moved: false, diff: [] };
    try {
      const res = await fetch(`${OLD_BASE}/api/customer-data?customerId=${encodeURIComponent(id)}`, { headers: { "x-staff-code": STAFF_PASSPHRASE } });
      if (res.status === 404) row.oldStatus = "旧側に記録なし";
      else if (!res.ok) row.oldStatus = "旧側と通信できず(" + res.status + ")";
      else { const d: any = await res.json().catch(() => null); row.old = summarize(d && d.customer); row.oldStatus = "取得OK"; }
    } catch { row.oldStatus = "旧側と通信できず"; }
    const doc: any = await store.get(`noteExtras/${id}`, { type: "json" });
    row.moved = !!doc;
    if (doc) row.now = summarize(doc);
    if (row.old) for (const k of KEYS) if ((row.old[k] || 0) > ((row.now && row.now[k]) || 0)) row.diff.push(k);
    return row;
  }));
  return json({ rows });
};

export const config: Config = { path: "/api/migration-check" };
