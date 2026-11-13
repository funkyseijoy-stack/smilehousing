import type { Context, Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";
import { sendNotifyMail } from "../lib/google.mts";

// 初期の打合せ記録のお客様用ページ（/kiroku/）のAPI。読み取りだけ。
// 案件ごとの earlyToken（住まいるアプリの「ヒアリング」タブで発行。おうちノートの noteToken とは別）で確認し、
// 「お客様に見せる」にした記録（project.earlyMeetings の shared:true）と資金計画・お見積り（project.financeDocs）、この案件の今後の予約（日時・種類だけ）、
// 会社紹介の文章（settings/main.companyIntro）を返す。社内の情報は返さない。予約の受付は note-calendar.mts（earlyToken でも可）。
// メッセージ：おうちノートと同じ messages コレクションのやりとりを返し、POST {p,t,action:"message",text} でお客様から送れる
// （fromCustomer:true で保存し、スタッフへ通知メール）。
// お家のイメージ：おうちノートと同じ imageBoard を返し、POST action:"imageAdd"／"imageDelete" でお客様が写真を足す・自分の写真を消す
// （場所タグ IMAGE_PLACES は note-data.mts・住まいるアプリと同じ内容にすること）。

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

const IMAGE_PLACES = ["外観", "玄関", "LDK", "キッチン", "お風呂", "洗面・脱衣", "トイレ", "階段", "寝室", "子供部屋", "その他"];
const IMAGE_MAX_BYTES = 4 * 1024 * 1024;
const IMAGE_MAX_PER_PROJECT = 200;
function imageOf(x: any) {
  return { id: x.id, url: x.url, place: x.place || "その他", by: x.by === "customer" ? "customer" : "staff", createdAt: x.createdAt || "",
    gallery: x.source === "gallery" ? String(x.galleryGroup || "イメージ集") : "", note: String(x.note || "").slice(0, 200) };
}
async function listImages(store: any, projectId: string) {
  const { blobs } = await store.list({ prefix: "imageBoard/" });
  const all = await Promise.all(blobs.map((bl: any) => store.get(bl.key, { type: "json" }).catch(() => null)));
  return all.filter((x: any) => x && x.projectId === projectId && !x.deletedAt);
}

// 「前回からの更新」用：作った時刻と直した時刻（お客様に見せる切り替えも含む）の新しいほう
function updAt(...xs: any[]): string {
  return xs.map((x) => String(x || "")).reduce((m, x) => (x > m ? x : m), "");
}

export default async (req: Request, context: Context) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (req.method !== "GET" && req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const url = new URL(req.url);
  let body: any = null;
  if (req.method === "POST") {
    try { body = await req.json(); } catch { return json({ error: "invalid_json" }, 400); }
  }
  const projectId = String((body ? body.p : url.searchParams.get("p")) || "");
  const token = String((body ? body.t : url.searchParams.get("t")) || "");
  if (!projectId || !token || projectId.includes("/")) return json({ error: "missing_link" }, 400);

  const store = getStore("staffData");
  const project: any = await store.get(`projects/${projectId}`, { type: "json" });
  // おうちノートのリンク（noteToken）でも開ける＝同じURLで切り替えられる（記録ページのリンクを発行した案件だけ）
  if (!project || project.deletedAt || !project.earlyToken || (project.earlyToken !== token && !(project.noteToken && project.noteToken === token))) {
    return json({ error: "invalid_link" }, 403);
  }

  if (body && body.action === "imageAdd") {
    const place = String(body.place || "");
    if (!IMAGE_PLACES.includes(place)) return json({ error: "unknown_place" }, 400);
    const m = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/.exec(String(body.dataUrl || ""));
    if (!m) return json({ error: "invalid_image" }, 400);
    let bytes: Uint8Array;
    try { bytes = Uint8Array.from(Buffer.from(m[2], "base64")); } catch { return json({ error: "invalid_base64" }, 400); }
    if (!bytes.length) return json({ error: "invalid_image" }, 400);
    if (bytes.length > IMAGE_MAX_BYTES) return json({ error: "too_large" }, 413);
    const existing = await listImages(store, projectId);
    if (existing.filter((x: any) => x.by === "customer" && x.source !== "gallery").length >= IMAGE_MAX_PER_PROJECT) return json({ error: "limit_reached" }, 429);
    const key = "p" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    await getStore("customerPhotos").set(`${projectId}/${key}`, bytes, { metadata: { contentType: m[1] } });
    const id = "img_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    const now = new Date().toISOString();
    const doc = {
      id, projectId, place, by: "customer", source: "kiroku", contentType: m[1],
      url: `/api/get-photo?slug=${encodeURIComponent(projectId)}&key=${encodeURIComponent(key)}`,
      fileName: String(body.fileName || "").slice(0, 120), note: String(body.note || "").trim().slice(0, 200), createdAt: now, updatedAt: now,
    };
    await store.setJSON(`imageBoard/${id}`, doc);
    return json({ ok: true, image: imageOf(doc) });
  }
  if (body && body.action === "imageDelete") {
    const id = String(body.id || "");
    const doc: any = id && !id.includes("/") ? await store.get(`imageBoard/${id}`, { type: "json" }) : null;
    if (!doc || doc.projectId !== projectId || doc.deletedAt) return json({ error: "not_found" }, 404);
    if (doc.by !== "customer" || doc.source === "gallery") return json({ error: "forbidden" }, 403);
    const now = new Date().toISOString();
    await store.setJSON(`imageBoard/${id}`, { ...doc, deletedAt: now, updatedAt: now });
    return json({ ok: true });
  }
  if (body) {
    if (body.action !== "message") return json({ error: "unknown_action" }, 400);
    const text = String(body.text || "").trim().slice(0, 2000);
    if (!text) return json({ error: "empty" }, 400);
    const now = new Date().toISOString();
    const id = "msg_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    const doc = {
      id, projectId, content: text, sender: (project.customer || "お客様") + "（お打合せの記録ページ）",
      fromCustomer: true, createdAt: now, updatedAt: now,
    };
    await store.setJSON(`messages/${id}`, doc);
    // お客様からのメッセージは、1通ずつ社内タスク（担当者なし＝朋子の「割り振り待ち」）にもする
    try {
      const taskId = "task_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
      await store.setJSON(`tasks/${taskId}`, {
        id: taskId, projectId, content: "【お客様からのメッセージ】" + text,
        assignee: "", instructor: "お客様", creator: "お打合せの記録ページ",
        hasDeadline: false, deadline: "", requestTo: "", requestMethod: "",
        attachmentAssetIds: [], attachments: [], private: false, reflected: false, reflectedAt: null,
        status: "未着手", fromCustomerMessage: { messageId: id },
        createdAt: now, updatedAt: now,
      });
      (doc as any).taskId = taskId;
      await store.setJSON(`messages/${id}`, doc);
    } catch (e) { console.error("message task failed", e); }
    // スタッフへ通知メール（失敗してもメッセージ送信自体は成功扱い）
    await sendNotifyMail(
      `【打合せ記録ページ】${project.customer || "お客様"}様からメッセージが届きました`,
      `${project.customer || "お客様"}様（${project.name || ""}）から、お打合せの記録ページでメッセージが届きました。\n\n${text}\n\n住まいるアプリの案件の「ヒアリング」タブ（または「メッセージ」タブ）から返信できます。`
    ).catch(() => {});
    return json({ ok: true, message: { content: doc.content, sender: doc.sender, fromCustomer: true, createdAt: now } });
  }

  const records = (Array.isArray(project.earlyMeetings) ? project.earlyMeetings : [])
    .filter((r: any) => r && r.shared && !r.deletedAt)
    .sort((a: any, b: any) =>
      String(b.date || "").localeCompare(String(a.date || "")) ||
      String(b.createdAt || "").localeCompare(String(a.createdAt || "")))
    .map((r: any) => ({
      id: String(r.id || ""),
      date: String(r.date || ""),
      title: String(r.title || ""),
      memo: String(r.memo || ""),
      upd: updAt(r.createdAt, r.updatedAt),
      files: (Array.isArray(r.files) ? r.files : [])
        .filter((f: any) => f && typeof f.url === "string" && f.url.startsWith("/api/get-photo?"))
        .map((f: any) => ({ url: f.url, contentType: String(f.contentType || ""), name: String(f.name || "") })),
    }));

  // 資金計画・お見積り（「お客様に見せる」にしたものだけ）。新しい日付が先
  const financeDocs = (Array.isArray(project.financeDocs) ? project.financeDocs : [])
    .filter((d: any) => d && d.shared && !d.deletedAt && d.file && typeof d.file.url === "string" && d.file.url.startsWith("/api/get-photo?"))
    .sort((a: any, b: any) =>
      String(b.date || "").localeCompare(String(a.date || "")) ||
      String(b.createdAt || "").localeCompare(String(a.createdAt || "")))
    .map((d: any) => ({
      kind: String(d.kind || "その他"),
      date: String(d.date || ""),
      upd: updAt(d.createdAt, d.updatedAt),
      memo: String(d.memo || ""),
      file: { url: d.file.url, contentType: String(d.file.contentType || ""), name: String(d.file.name || "") },
    }));

  // ヒアリング（「お客様に見せる」にチェックした項目だけ。並びと見出しは住まいるアプリの HEARING_FIELDS と同じ）
  const HEARING_LABELS: [string, string][] = [
    ["family", "家族構成・暮らし方"], ["mood", "どんな雰囲気の家にしたいか"], ["plan", "間取りの希望"],
    ["material", "素材・設備のこだわり"], ["trouble", "今の住まいの不満・解決したいこと"], ["budget", "予算・資金計画"],
    ["timing", "時期・土地"], ["other", "その他・メモ"],
  ];
  const hf = (project.hearing && project.hearing.fields) || {};
  const hs = (project.hearing && project.hearing.shared) || {};
  const hearing = HEARING_LABELS
    .filter(([k]) => hs[k] === true && typeof hf[k] === "string" && hf[k].trim())
    .map(([k, label]) => ({ label, text: String(hf[k]).trim().slice(0, 3000) }));
  const hearingAt = hearing.length ? String((project.hearing && project.hearing.updatedAt) || "").slice(0, 10) : "";
  const hearingUpd = hearing.length ? String((project.hearing && project.hearing.updatedAt) || "") : "";

  // この案件の今日以降の予約（ごみ箱に入れたものは除く）。日時と種類だけ返す
  const today = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
  const { blobs } = await store.list({ prefix: "reservations/" });
  const resAll = await Promise.all(blobs.map((bl) => store.get(bl.key, { type: "json" }).catch(() => null)));
  const reservations = resAll
    .filter((r: any) => r && r.projectId === projectId && !r.deletedAt && String(r.date || "") >= today)
    .map((r: any) => ({ type: String(r.type || ""), date: String(r.date || ""), startTime: String(r.startTime || ""), endTime: String(r.endTime || ""), createdAt: String(r.createdAt || "") }))
    .sort((a, b) => (a.date + a.startTime).localeCompare(b.date + b.startTime));

  // メッセージ（おうちノートと同じやりとり。古い順）
  const { blobs: mblobs } = await store.list({ prefix: "messages/" });
  const msgAll = await Promise.all(mblobs.map((bl) => store.get(bl.key, { type: "json" }).catch(() => null)));
  const messages = msgAll
    .filter((m: any) => m && m.projectId === projectId && !m.deletedAt)
    // おうちノートのカードへの「変更のご依頼」とその返信は、おうちノートのカードの下に出すので、ここには出さない
    .filter((m: any, _i: number, all: any[]) => !m.chgKey && !(m.replyTo && all.some((x: any) => x && x.id === m.replyTo && x.chgKey)))
    .map((m: any) => ({ content: String(m.content || ""), sender: String(m.sender || ""), fromCustomer: !!m.fromCustomer, createdAt: String(m.createdAt || "") }))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  // 会社紹介（住まいるアプリの「業者・設定」で保存した文章。未保存なら出さない）
  const settings: any = await store.get("settings/main", { type: "json" }).catch(() => null);
  const ci = settings && settings.companyIntro;
  const ciOn = !!ci && ci.on !== false;
  const companyIntro = ciOn && typeof ci.text === "string" && ci.text.trim() ? ci.text.slice(0, 3000) : "";
  // 家づくりの流れ（会社紹介の中に、小さな見出し＋文章で出す）。見出しか本文のどちらかがあれば出す
  const pt = ciOn && typeof ci.policyTitle === "string" ? ci.policyTitle.trim().slice(0, 100) : "";
  const px = ciOn && typeof ci.policyText === "string" ? ci.policyText.trim().slice(0, 3000) : "";
  const policy = pt || px ? { title: pt, text: px } : null;

  // お家のイメージ（おうちノートと同じ imageBoard。新しい順）
  const images = (await listImages(store, projectId)).filter((x: any) => x.url).map(imageOf)
    .sort((a: any, b: any) => b.createdAt.localeCompare(a.createdAt));

  return json({
    imagePlaces: IMAGE_PLACES,
    images,
    view: project.noteView === "kiroku" ? "kiroku" : (project.noteView === "note" ? "note" : ""), // スタッフが選んだ「お客様のリンクで開くページ」
    customer: String(project.customer || project.name || ""),
    today,
    records,
    financeDocs,
    hearing,
    hearingAt,
    hearingUpd,
    // スタッフの「お客様へのひとこと」（住まいるアプリの案件「ヒアリング」タブで書く。空なら出さない）
    staffComment: project.staffComment && String(project.staffComment.text || "").trim()
      ? { text: String(project.staffComment.text).slice(0, 500), at: String(project.staffComment.at || "") }
      : null,
    reservations,
    messages,
    companyIntro,
    policy,
  });
};

export const config: Config = {
  path: "/api/early-data",
};
