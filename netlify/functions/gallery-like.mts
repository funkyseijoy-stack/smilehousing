import type { Context, Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";

// 施工事例・イメージ集（/gallery/）の「いいね🩷」。
// おうちノート（noteToken）か、お打合せの記録（earlyToken）のリンクから開いたお客様だけ、いいねをサーバーに保存する。
// 保存先はおうちノートの「お家のイメージ」と同じ imageBoard コレクション（source:"gallery"）。
// ID は gl_<案件ID>_<写真ID> で固定（同じ写真を何度押しても1件。取り消しは deletedAt を付けるだけ）。
// 住まいるアプリの「写真・アルバム」→「お家のイメージ」と「ヒアリング」タブ、おうちノートの「イメージ」に出る。
// 写真そのものは /gallery/p/<写真ID>.jpg（公開ページの写真）を参照するだけで、コピーはしない。

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

// イメージ集のタブ（写真IDの先頭）→ お家のイメージの場所タグ（note-data.mts の IMAGE_PLACES のどれか）
const PLACE_BY_GROUP: Record<string, string> = {
  gaikan: "外観",
  entrance: "玄関",
  ldk: "LDK",
  sanitary: "洗面・脱衣",
  laundry: "洗面・脱衣",
};
const GROUP_NAMES: Record<string, string> = {
  gaikan: "外観", entrance: "エントランス", ldk: "LDK", sanitary: "サニタリー", laundry: "ランドリー",
  storage: "収納", other: "その他",
};
const PHOTO_ID_RE = /^([a-z]+[0-9]?)-(\d{3})$/;
const MAX_LIKES = 300;

function groupLabel(group: string) {
  const m = /^case(\d+)$/.exec(group);
  return m ? `事例 ${m[1]}` : (GROUP_NAMES[group] || "その他");
}

export default async (req: Request, context: Context) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (req.method !== "GET" && req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const url = new URL(req.url);
  let body: any = {};
  if (req.method === "POST") {
    try { body = await req.json(); } catch { return json({ error: "invalid_json" }, 400); }
  }
  const projectId = String((req.method === "POST" ? body.p : url.searchParams.get("p")) || "");
  const token = String((req.method === "POST" ? body.t : url.searchParams.get("t")) || "");
  if (!projectId || !token || projectId.includes("/")) return json({ error: "missing_link" }, 400);

  const store = getStore("staffData");
  const project: any = await store.get(`projects/${projectId}`, { type: "json", consistency: "strong" });
  const okToken = !!project && !project.deletedAt &&
    ((project.noteToken && project.noteToken === token) || (project.earlyToken && project.earlyToken === token));
  if (!okToken) return json({ error: "invalid_link" }, 403);

  const prefix = `imageBoard/gl_${projectId}_`;
  const listLiked = async () => {
    const { blobs } = await store.list({ prefix });
    const docs = await Promise.all(blobs.map((b) => store.get(b.key, { type: "json" })));
    return (docs.filter(Boolean) as any[]).filter((d) => !d.deletedAt && d.projectId === projectId);
  };

  if (req.method === "GET") {
    const liked = await listLiked();
    return json({ ok: true, liked: liked.map((d) => String(d.galleryId || "")).filter(Boolean) });
  }

  const photoId = String(body.photo || "");
  const m = PHOTO_ID_RE.exec(photoId);
  if (!m) return json({ error: "invalid_photo" }, 400);
  const group = m[1];
  const like = body.like !== false;
  const key = `${prefix}${photoId}`;
  const now = new Date().toISOString();
  const existing: any = await store.get(key, { type: "json", consistency: "strong" });

  if (like) {
    if (existing && !existing.deletedAt) return json({ ok: true, liked: true });
    if (!existing) {
      const count = (await listLiked()).length;
      if (count >= MAX_LIKES) return json({ error: "limit_reached" }, 429);
    }
    const doc = {
      ...(existing || {}),
      id: `gl_${projectId}_${photoId}`,
      projectId,
      place: PLACE_BY_GROUP[group] || "その他",
      by: "customer",
      source: "gallery",
      galleryId: photoId,
      galleryGroup: groupLabel(group),
      contentType: "image/jpeg",
      url: `/gallery/p/${photoId}.jpg`,
      thumbUrl: `/gallery/t/${photoId}.jpg`,
      via: project.noteToken === token ? "note" : "kiroku",
      createdAt: existing?.createdAt && !existing.deletedAt ? existing.createdAt : now,
      updatedAt: now,
      deletedAt: null,
    };
    await store.setJSON(key, doc);
    return json({ ok: true, liked: true });
  }

  if (existing && !existing.deletedAt) {
    await store.setJSON(key, { ...existing, deletedAt: now, updatedAt: now });
  }
  return json({ ok: true, liked: false });
};

export const config: Config = {
  path: "/api/gallery-like",
};
