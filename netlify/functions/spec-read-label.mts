import type { Context, Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";

// 仕様タブの「色見本カード」用：撮影した色見本の写真から、色の名前・品番をAI（Claude）で読み取る。
// 写真は住まいるアプリが保存したもの（/api/get-photo?slug=...&key=...）だけを、サーバーが直接読む。
// 認証は他の機能と同じ合言葉（X-Staff-Token）。AIを使うには Netlify の環境変数 ANTHROPIC_API_KEY が必要。
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Staff-Token",
};
// staff-auth.mts と同じ値にしてください。
const STAFF_PASSPHRASE = "sumairu2026";
const MODEL = "claude-sonnet-5-5";
const MAX_BYTES = 4_500_000; // AIに渡せる画像の大きさの上限（約5MB）の手前

function json(obj: any, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

function b64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let s = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) s += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(s);
}

export default async (req: Request, context: Context) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  if (req.headers.get("x-staff-token") !== STAFF_PASSPHRASE) return json({ error: "unauthorized" }, 401);

  const apiKey = Netlify.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) return json({ error: "no_api_key" }, 501);

  let body: any;
  try { body = await req.json(); } catch { return json({ error: "invalid_json" }, 400); }
  // 受け付けるのは、保存済みの写真（/api/get-photo?slug=&key=）だけ
  let slug = "", key = "";
  try {
    const u = new URL(String(body.url || ""), "https://x.invalid");
    if (u.pathname !== "/api/get-photo") return json({ error: "bad_url" }, 400);
    slug = u.searchParams.get("slug") || "";
    key = u.searchParams.get("key") || "";
  } catch { return json({ error: "bad_url" }, 400); }
  if (!slug || !key) return json({ error: "bad_url" }, 400);

  const photos = getStore("customerPhotos");
  const got: any = await photos.getWithMetadata(`${slug}/${key}`, { type: "arrayBuffer" });
  if (!got || !got.data) return json({ error: "not_found" }, 404);
  if (got.data.byteLength > MAX_BYTES) return json({ error: "too_large" }, 413);
  let mt = String((got.metadata && got.metadata.contentType) || "");
  if (!/^image\/(jpeg|png|gif|webp)$/.test(mt)) return json({ error: "not_image" }, 415);

  const prompt =
    "これは住宅の外壁・屋根などの色見本や仕様書をスマホで撮影した写真です。" +
    "写真に印字されている『色の名前（例：Aオフホワイト NC）』と『品番・色番（例：B152）』を読み取ってください。" +
    "写真に複数の色がある場合は、中央にある（いちばん大きく写っている）ものだけにしてください。" +
    "読み取れない・書かれていないときは空の文字列にしてください。推測で作らないでください。" +
    "次のJSONだけを返してください（前後に文章は付けない）：" +
    '{"name":"色の名前","code":"品番・色番","maker":"メーカー名"}';

  let res: Response;
  try {
    res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 300,
        messages: [{
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: mt, data: b64(got.data) } },
            { type: "text", text: prompt },
          ],
        }],
      }),
    });
  } catch {
    return json({ error: "ai_unreachable" }, 502);
  }
  if (!res.ok) return json({ error: "ai_failed", status: res.status }, 502);
  const j: any = await res.json().catch(() => null);
  const text = j && Array.isArray(j.content) ? j.content.map((c: any) => c.text || "").join("") : "";
  const m = text.match(/\{[\s\S]*\}/);
  let out: any = {};
  try { out = m ? JSON.parse(m[0]) : {}; } catch { out = {}; }
  const clean = (v: any) => String(v || "").replace(/\s+/g, " ").trim().slice(0, 40);
  const name = clean(out.name), code = clean(out.code), maker = clean(out.maker);
  return json({ ok: true, name, code, maker });
};

export const config: Config = {
  path: "/api/spec-read-label",
};
