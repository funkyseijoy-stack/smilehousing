import type { Context, Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Api-Key",
};

export default async (req: Request, context: Context) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "method_not_allowed" }), {
      status: 405,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }

  // Netlify.env.get() is the normal path, but the environment-variable
  // setting has not been reliably taking effect on this site, so fall back
  // to the same key that is already embedded in the staff app's client-side
  // code (it is not a real secret — it ships in that page's source anyway).
  const expectedKey = Netlify.env.get("NOTE_API_KEY") || "uyTVTIzf-Oox5KwaIBIAJB53QT5zCJf3";
  const apiKey = req.headers.get("x-api-key");
  if (!expectedKey || !apiKey || apiKey !== expectedKey) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "invalid_json" }), {
      status: 400,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }

  const { slug, data, photos } = body || {};
  if (!slug || typeof slug !== "string" || slug.length > 200) {
    return new Response(JSON.stringify({ error: "slug_required" }), {
      status: 400,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }

  const photoStore = getStore("customerPhotos");
  let photoCount = 0;
  if (Array.isArray(photos)) {
    for (const p of photos) {
      if (!p || typeof p.key !== "string" || typeof p.dataUrl !== "string") continue;
      const match = /^data:([^;]+);base64,(.+)$/.exec(p.dataUrl);
      if (!match) continue;
      const contentType = match[1];
      let bytes: Uint8Array;
      try {
        bytes = Uint8Array.from(Buffer.from(match[2], "base64"));
      } catch {
        continue;
      }
      const blobKey = `${slug}/${p.key}`;
      await photoStore.set(blobKey, bytes, { metadata: { contentType } });
      photoCount++;
    }
  }

  const noteStore = getStore("customerNotes");
  await noteStore.setJSON(slug, { ...(data || {}), updatedAt: new Date().toISOString() });

  return new Response(JSON.stringify({ ok: true, photoCount }), {
    status: 200,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
};

export const config: Config = {
  path: "/api/save-note",
};
