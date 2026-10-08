import type { Context, Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";
import { sendMailTo, CUSTOMER_MAIL_FROM_NAME, CUSTOMER_MAIL_SIGNATURE } from "../lib/google.mts";
import { getExtras } from "../lib/note-extras.mts";

// スタッフがおうちノートにメッセージを入れたとき、お客様が登録したメールアドレスへお知らせを送る。
// メッセージの内容は書かず、ノートを開くリンクだけを送る。宛先は、お客様がおうちノートで自分で登録したアドレスだけ。
// 認証は他の機能と同じ合言葉（X-Staff-Token）。
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Staff-Token",
};
// staff-auth.mts と同じ値にしてください。
const STAFF_PASSPHRASE = "sumairu2026";
const SITE = "https://sprightly-pegasus-9b65a7.netlify.app";

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

  let body: any;
  try { body = await req.json(); } catch { return json({ error: "invalid_json" }, 400); }
  const projectId = String(body.projectId || "");
  if (!projectId) return json({ error: "missing_fields" }, 400);

  const store = getStore("staffData");
  const project: any = await store.get(`projects/${projectId}`, { type: "json" });
  if (!project || project.deletedAt || !project.noteToken) return json({ error: "not_found" }, 404);
  const extras: any = await getExtras(store, projectId);
  if (!extras) return json({ error: "unavailable" }, 502);
  const email = extras.notifyEmail && extras.notifyEmail.email;
  if (!email) return json({ ok: true, sent: false, reason: "no_email" });

  const link = `${SITE}/note/?p=${encodeURIComponent(projectId)}&t=${encodeURIComponent(project.noteToken)}`;
  const name = String(project.customer || "お客").replace(/様$/, "");
  const sent = await sendMailTo({
    to: email,
    subject: "【住まいるハウジング】おうちノートにメッセージが届いています",
    body:
      `${name}様\n\n` +
      `いつもありがとうございます。住まいるハウジングです。\n` +
      `おうちノートに、担当者からのメッセージが届いています。\n` +
      `下のリンクから、おうちノートの「メッセージ」をご確認ください。\n\n` +
      `${link}\n\n` +
      `※このメールは、おうちノートでご登録いただいたメールアドレスへお送りしています。\n` +
      `※ご返信は、おうちノートのメッセージ、または、これまで通りLINEでも大丈夫です。\n` +
      `※数分たっても届かない場合は、迷惑メールフォルダもご確認ください。\n` +
      CUSTOMER_MAIL_SIGNATURE,
    fromName: CUSTOMER_MAIL_FROM_NAME,
  });
  if (!sent.ok) return json({ error: "send_failed" }, 502);
  return json({ ok: true, sent: true, to: email });
};

export const config: Config = {
  path: "/api/note-notify",
};
