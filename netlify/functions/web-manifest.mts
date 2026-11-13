import type { Context, Config } from "@netlify/functions";

// おうちノート（/note/）・お打合せの記録ページ（/kiroku/）の「ホーム画面に追加」用の説明書き（Web App Manifest、2026年11月〜）。
// iPhoneは、ホーム画面に追加したアプリ（display:standalone）でないとプッシュ通知を受け取れないため。
// 開くページは呼び出した画面と同じリンク（p・t）。中身は返さないので確認はしない（リンクの文字をそのまま入れるだけ）。
export default async (req: Request, context: Context) => {
  const url = new URL(req.url);
  const page = url.searchParams.get("page") === "kiroku" ? "kiroku" : "note";
  const p = String(url.searchParams.get("p") || "").slice(0, 80);
  const t = String(url.searchParams.get("t") || "").slice(0, 120);
  const ok = /^[A-Za-z0-9_-]*$/.test(p) && /^[A-Za-z0-9_-]*$/.test(t);
  const start = ok && p && t ? `/${page}/?p=${encodeURIComponent(p)}&t=${encodeURIComponent(t)}` : `/${page}/`;
  const name = page === "kiroku" ? "お打合せの記録" : "おうちノート";
  const manifest = {
    name: name + "｜住まいるハウジング",
    short_name: name,
    start_url: start,
    id: start,
    scope: "/",
    display: "standalone",
    background_color: "#f7f3ee",
    theme_color: "#3a302b",
    lang: "ja",
    icons: [{ src: "/note/icons/apple-touch-icon.png", sizes: "180x180", type: "image/png", purpose: "any" }],
  };
  return new Response(JSON.stringify(manifest), { headers: { "Content-Type": "application/manifest+json", "Cache-Control": "no-store" } });
};

export const config: Config = {
  path: "/api/web-manifest",
};
