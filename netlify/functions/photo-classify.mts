import type { Context, Config } from "@netlify/functions";

// 打合せ記録に写真を付けたとき、写真の中身から「部位の候補」と「写真に印字された色名・品番」をAI（Claude）で判定する。
// 写真は画面側で小さく縮めたJPEG（base64）を受け取る。保存はしない。候補を返すだけ。
// 認証は他の機能と同じ合言葉（X-Staff-Token）。AIを使うには Netlify の環境変数 ANTHROPIC_API_KEY が必要。
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Staff-Token",
};
// staff-auth.mts と同じ値にしてください。
const STAFF_PASSPHRASE = "sumairu2026";
const MODEL = "claude-sonnet-5-5";
const MAX_B64 = 3_000_000; // base64で約3MBまで（画面側で約1MB以下に縮める）
// 画面（public/app/index.html の MN_AI_PARTS）と同じ名前にすること
const PARTS = ["外部", "暖房設備", "換気設備", "電気配線", "あかりプラン", "キッチン", "お風呂", "洗面", "トイレ", "脱衣室"];

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

  const apiKey = Netlify.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) return json({ error: "no_api_key" }, 501);

  let body: any;
  try { body = await req.json(); } catch { return json({ error: "invalid_json" }, 400); }
  const data = String(body.data || "");
  const mt = String(body.mediaType || "image/jpeg");
  if (!data) return json({ error: "no_image" }, 400);
  if (data.length > MAX_B64) return json({ error: "too_large" }, 413);
  if (!/^image\/(jpeg|png|gif|webp)$/.test(mt)) return json({ error: "not_image" }, 415);

  const prompt =
    "これは住宅会社のスタッフが、お客様との打合せ記録に添付するためにスマホで撮った写真です（カタログ・サンプル・図面・商品・現場など）。" +
    "次の2つを判定してください。\n" +
    "1) part：写真が主に何の部位かを、次の中から1つだけ選ぶ。" + PARTS.join("／") + "。" +
    "どれとも言い切れない・複数にまたがる・部位が分からないときは空の文字列にする（無理に当てはめない）。\n" +
    "2) text：写真に印字されている『色の名前』『品番・色番』『商品名』を、読み取れたものだけ短く書く（例：「サンゲツ FE-1234」「Aオフホワイト NC B152」）。読めない・書かれていないときは空の文字列。推測で作らない。\n" +
    "次のJSONだけを返してください（前後に文章は付けない）：" +
    '{"part":"","text":""}';

  let res: Response;
  try {
    res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 200,
        messages: [{
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: mt, data } },
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
  const part = PARTS.indexOf(String(out.part || "").trim()) >= 0 ? String(out.part).trim() : "";
  const label = String(out.text || "").replace(/\s+/g, " ").trim().slice(0, 60);
  return json({ ok: true, part, text: label });
};

export const config: Config = {
  path: "/api/photo-classify",
};
