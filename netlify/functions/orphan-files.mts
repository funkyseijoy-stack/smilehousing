import type { Context, Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";

// 案件の保管場所（customerPhotos の "<案件ID>/"）にあるファイルの一覧を返すだけ（読み取り専用）。
// 記録の行から外れてしまったファイルを探して付け直すために使う。どれがどこにも付いていないかは画面側で判定する。
// staff-auth.mts と同じ値にしてください。
const STAFF_PASSPHRASE = "sumairu2026";

const json = (b: any, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });

export default async (req: Request, _context: Context) => {
  if (req.headers.get("x-staff-token") !== STAFF_PASSPHRASE) return json({ error: "unauthorized" }, 401);
  const url = new URL(req.url);
  const slug = String(url.searchParams.get("slug") || "");
  if (!slug || slug.includes("/") || slug.length > 120) return json({ error: "slug_required" }, 400);
  const days = Math.min(Math.max(Number(url.searchParams.get("days")) || 7, 1), 365);
  const since = Date.now() - days * 86400000;
  const store = getStore({ name: "customerPhotos", consistency: "strong" });
  const items: any[] = [];
  const { blobs } = await store.list({ prefix: slug + "/" });
  for (const b of blobs) {
    const key = b.key.slice(slug.length + 1);
    // key は "p" + Date.now() の36進数（8文字）＋ランダム6文字
    const m = /^p([0-9a-z]{8})/.exec(key);
    const at = m ? parseInt(m[1], 36) : 0;
    if (!at || at < since) continue;
    items.push({ key, at });
  }
  items.sort((a, b) => b.at - a.at);
  const top = items.slice(0, 80);
  await Promise.all(top.map(async (it) => {
    try {
      const md: any = await store.getMetadata(slug + "/" + it.key);
      it.contentType = (md && md.metadata && md.metadata.contentType) || "";
    } catch { it.contentType = ""; }
    it.url = "/api/get-photo?slug=" + encodeURIComponent(slug) + "&key=" + encodeURIComponent(it.key);
    it.id = slug + "/" + it.key;
  }));
  return json({ ok: true, items: top, total: items.length });
};

export const config: Config = { path: "/api/orphan-files" };
