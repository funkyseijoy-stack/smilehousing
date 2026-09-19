import type { Context, Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";

export default async (req: Request, context: Context) => {
  const url = new URL(req.url);
  const slug = url.searchParams.get("slug");
  const key = url.searchParams.get("key");
  if (!slug || !key) {
    return new Response(JSON.stringify({ error: "slug_and_key_required" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const store = getStore("customerPhotos");
  const blobKey = `${slug}/${key}`;
  const result = await store.getWithMetadata(blobKey, { type: "arrayBuffer" });
  if (!result || !result.data) {
    return new Response(JSON.stringify({ error: "not_found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }

  const contentType = (result.metadata && (result.metadata as any).contentType) || "application/octet-stream";

  return new Response(result.data, {
    status: 200,
    headers: {
      "Content-Type": contentType,
      "Cache-Control": "public, max-age=31536000, immutable",
    },
  });
};

export const config: Config = {
  path: "/api/get-photo",
};
