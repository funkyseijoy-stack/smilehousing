import type { Context, Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";
import { sendNotifyMail } from "../lib/google.mts";
import { listCollection } from "../lib/booking.mts";
import { boaxelForNote, boaxelForPublic, boaxelParts, boaxelPlan, PLACE_TYPES, MASU_CM } from "../lib/boaxel.mts";

// 収納プラン（IKEA ボーアクセル）のページ /shuno/ 用。
// ①おうちノートのお客様：?p=<案件ID>&t=<noteToken>（試しの間はデモの案件だけ＝boaxelForNote）
// ②OBのお客様など：ログイン不要の公開ページ（「業者・設定」で「公開ページを出す」にしたときだけ＝boaxelForPublic）
// ③スタッフの確認：住まいるアプリにログインしている端末から開くと、x-staff-code で公開前でも見られる
// 依頼は社内タスク（担当なし＝割り振り待ち）にして、スタッフへ通知メール。
// 合言葉を変えるときは、ほかのFunctionと同じ値にそろえること。
const STAFF_PASSPHRASE = "sumairu2026";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, x-staff-code",
};
function json(obj: any, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { ...CORS_HEADERS, "Content-Type": "application/json", "Cache-Control": "no-store" } });
}
function genId(prefix: string) { return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
const toHalf = (s: string) => s.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0)).replace(/[ー－―‐]/g, "-");
const clean = (v: any, max: number) => String(v == null ? "" : v).replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max);
const IMAGE_MAX_BYTES = 4 * 1024 * 1024;
const MAX_PUBLIC_PER_DAY = 20;   // 公開ページの依頼の上限（24時間）
const MAX_PER_CONTACT_DAY = 3;   // 同じ電話番号・メールの上限（24時間）
const MAX_PER_PROJECT = 50;      // おうちノートの1案件あたり

function stateOf(t: any) { return t.status === "完了" ? "ご注文済み" : (t.status === "未着手" ? "受付済み" : "確認中"); }

export default async (req: Request, context: Context) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (req.method !== "GET" && req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  const store = getStore("staffData");
  const url = new URL(req.url);
  let body: any = {};
  if (req.method === "POST") { try { body = await req.json(); } catch { return json({ error: "invalid_json" }, 400); } }
  const p = String((req.method === "POST" ? body.p : url.searchParams.get("p")) || "");
  const t = String((req.method === "POST" ? body.t : url.searchParams.get("t")) || "");
  const staff = req.headers.get("x-staff-code") === STAFF_PASSPHRASE;
  const settings: any = await store.get("settings/main", { type: "json" }).catch(() => null);

  // どのお客様か
  let project: any = null, mode = "public";
  if (p || t) {
    if (!p || !t) return json({ error: "missing_link" }, 400);
    project = await store.get(`projects/${p}`, { type: "json" }).catch(() => null);
    if (!project || project.deletedAt || !project.noteToken || project.noteToken !== t) return json({ error: "invalid_link" }, 403);
    mode = "note";
  }
  const cat = mode === "note" ? (boaxelForNote(settings, project) || (staff ? boaxelParts(settings) : null))
    : (boaxelForPublic(settings) || (staff ? boaxelParts(settings) : null));
  if (!cat) return json({ error: "unavailable" }, 404);

  if (req.method === "GET") {
    let requests: any[] = [];
    if (mode === "note") {
      const tasks = await listCollection(store, "tasks");
      requests = tasks.filter((x: any) => x.projectId === project.id && x.fromBoaxel && !x.deletedAt)
        .sort((a: any, b: any) => String(b.createdAt || "").localeCompare(String(a.createdAt || ""))).slice(0, 20)
        .map((x: any) => ({ id: x.id, at: x.createdAt, names: (x.fromBoaxel.places || []).map((pl: any) => pl.name).join("・") || x.fromBoaxel.name || "収納プラン", total: x.fromBoaxel.total, state: stateOf(x) }));
    }
    return json({
      mode, preview: staff && (mode === "public" ? !boaxelForPublic(settings) : !boaxelForNote(settings, project)),
      customer: mode === "note" ? (project.customer || "") : "",
      parts: cat.parts, sets: cat.sets || [], note: cat.note, placeTypes: PLACE_TYPES, masuCm: MASU_CM, requests,
    });
  }

  // ---------- 依頼する ----------
  if (body.action !== "request") return json({ error: "unknown_action" }, 400);
  if (clean(body.website, 100)) return json({ ok: true }); // ハニーポット
  const pp: any = boaxelPlan(cat, body.plan || {});
  if (!pp) return json({ error: "empty" }, 400);
  if (pp.error) return json({ error: pp.error, place: pp.place }, 400);
  const note = String(body.note == null ? "" : body.note).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim().slice(0, 800);
  const now = new Date().toISOString();

  // 連絡先（公開ページだけ必須）
  let contact: any = null;
  if (mode === "public") {
    const name = clean(body.name, 50);
    const phone = toHalf(clean(body.phone, 20));
    const email = clean(body.email, 100).toLowerCase();
    const addr = clean(body.addr, 100);
    if (!name) return json({ error: "name_required" }, 400);
    const pd = phone.replace(/\D/g, "");
    if (phone && (pd.length < 10 || pd.length > 11)) return json({ error: "invalid_phone" }, 400);
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ error: "invalid_email" }, 400);
    if (!pd && !email) return json({ error: "contact_required" }, 400);
    contact = { name, phone, email, addr };
    // 受付の上限（いたずら・連打対策）
    const logKey = "shunoPublicLog";
    const log: any = (await store.get(logKey, { type: "json" }).catch(() => null)) || { entries: [] };
    const since = Date.now() - 24 * 3600 * 1000;
    const entries = (log.entries || []).filter((e: any) => Date.parse(e.at) > since);
    if (entries.length >= MAX_PUBLIC_PER_DAY) return json({ error: "too_many" }, 429);
    const keyOf = (pd || email);
    if (entries.filter((e: any) => e.key === keyOf).length >= MAX_PER_CONTACT_DAY) return json({ error: "too_many" }, 429);
    entries.push({ at: now, key: keyOf });
    await store.setJSON(logKey, { entries });
  } else {
    const tasks = await listCollection(store, "tasks");
    if (tasks.filter((x: any) => x.projectId === project.id && x.fromBoaxel && !x.deletedAt).length >= MAX_PER_PROJECT) return json({ error: "too_many" }, 429);
  }

  // 絵（場所ごとの正面図をまとめた1枚）
  const attachments: any[] = [];
  const slug = mode === "note" ? project.id : "shuno";
  const dm = /^data:(image\/(?:jpeg|png));base64,(.+)$/.exec(String(body.image || ""));
  if (dm) {
    try {
      const bytes = Uint8Array.from(Buffer.from(dm[2], "base64"));
      if (bytes.length && bytes.length <= IMAGE_MAX_BYTES) {
        const key = "p" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
        await getStore("customerPhotos").set(`${slug}/${key}`, bytes, { metadata: { contentType: dm[1] } });
        attachments.push({ id: genId("att"), url: `/api/get-photo?slug=${encodeURIComponent(slug)}&key=${encodeURIComponent(key)}`, contentType: dm[1], name: `収納プラン_${now.slice(5, 10).replace("-", "")}.${dm[1] === "image/png" ? "png" : "jpg"}`, fromCustomer: true });
      }
    } catch (e) { console.error("shuno image failed", e); }
  }

  const yen = (n: number) => n.toLocaleString("ja-JP") + "円";
  const who = mode === "note" ? ((project.customer ? project.customer + "様" : "お客様") + "（" + (project.name || "") + "）") : (contact.name + "様（公開ページ）");
  const placeTxt = pp.places.map((pl: any) => "■ " + pl.name + "（" + pl.typeName + "・" + (pl.cm ? "内寸" + pl.cm + "cm" : pl.masu + "マス") + "・高さ" + pl.height + "cm）\n　" +
    pl.cols.map((c: any, i: number) => (i + 1) + "列目 " + c.w + "cm・" + (c.kindName || "") + "：" + c.items.length + "段（うち標準" + c.std + "）").join("／")).join("\n");
  const lineTxt = pp.lines.map((l: any) => `・${l.name}${l.size ? " " + l.size + "cm" : ""}${l.code ? "（" + l.code + "）" : ""} × ${l.qty}${l.std ? "（うち標準" + l.std + "）" : ""}${l.sub ? "　" + yen(l.sub) : ""}`).join("\n");
  const content = "【収納プランのご依頼】" + who +
    (contact ? "\n連絡先：" + [contact.phone, contact.email].filter(Boolean).join("／") + (contact.addr ? "\n住所・お家：" + contact.addr : "") : "") +
    "\n" + placeTxt + "\n部品：\n" + lineTxt +
    (pp.total != null ? "\n追加分の目安：" + yen(pp.total) + "（税込・部品代のみ。標準の縦レール・棚・ブラケットは含まない）" : "") +
    (note ? "\nひとこと：" + note : "");
  const taskId = genId("task_bx_");
  const task = {
    id: taskId, projectId: mode === "note" ? project.id : "", content,
    assignee: "", instructor: "お客様", creator: mode === "note" ? "おうちノート" : "収納プラン（公開ページ）",
    hasDeadline: false, deadline: "", requestTo: "", requestMethod: "",
    attachmentAssetIds: [], attachments, private: false, reflected: false, reflectedAt: null,
    status: "未着手",
    fromBoaxel: { places: pp.places, lines: pp.lines, total: pp.total, note, contact, public: mode === "public", at: now },
    createdAt: now, updatedAt: now,
  };
  await store.setJSON(`tasks/${taskId}`, task);
  await sendNotifyMail(`【収納プラン】${who}からご依頼が届きました`, `${who}から、収納プラン（ボーアクセル）のご依頼が届きました。\n\n${content}\n\n住まいるアプリのホームのタスク（割り振り待ち）に入っています。プランの絵も付いています。`).catch(() => {});
  return json({ ok: true, req: { id: taskId, at: now, names: pp.places.map((pl: any) => pl.name).join("・"), total: pp.total, state: "受付済み" } });
};

export const config: Config = { path: "/api/shuno" };
