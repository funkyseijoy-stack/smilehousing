import type { Context, Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";

// 新おうちノート（/note/）用のお客様向けAPI。
// 住まいるアプリと同じデータストア（staffData）を直接読むため、
// スタッフ側で登録・反映した内容がそのままお客様の画面に出る（平面図・仕様・打合せ記録など）。
// お客様はスタッフ用の合言葉を持たないため、案件ごとの noteToken（住まいるアプリで発行）で認証する。

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

function genId(prefix: string) {
  return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 9);
}

// お客様画面の「設備仕様」一覧。玄関は外部に統合している。
// match: [scope, category|null]（nullはそのscopeの全カテゴリー）
const NOTE_CATS = [
  { id: "plan", name: "平面図", sub: "図面を確認できます", icon: "plan" },
  { id: "exterior", name: "外部", sub: "外壁・屋根・破風・サッシ・玄関", icon: "house" },
  { id: "kitchen", name: "キッチン", sub: "プランボード・設備仕様", icon: "kitchen" },
  { id: "bath", name: "お風呂", sub: "プランボード・設備仕様", icon: "bath" },
  { id: "wash", name: "洗面", sub: "洗面台・ミラー・収納", icon: "wash" },
  { id: "toilet1", name: "1階トイレ", sub: "商品・リモコン・床", icon: "toilet" },
  { id: "toilet2", name: "2階トイレ", sub: "商品・リモコン・床", icon: "toilet" },
  { id: "heating", name: "暖房設備", sub: "暖房機器・設置場所", icon: "heating" },
  { id: "ventilation", name: "換気設備", sub: "換気方式・給排気口", icon: "fan" },
  { id: "wiring", name: "電気配線", sub: "照明・スイッチ・コンセント", icon: "plug" },
  { id: "lighting", name: "あかりプラン", sub: "照明計画", icon: "light" },
  { id: "interior", name: "インテリアメイン", sub: "床・建具・クロス・配色", icon: "sofa" },
];

function noteCatFor(scope?: string, category?: string | null): string | null {
  if (!scope) return null;
  if (scope === "exterior") return "exterior";
  if (scope === "facility") {
    if (category === "キッチン") return "kitchen";
    if (category === "お風呂") return "bath";
    if (category === "洗面" || category === "脱衣室") return "wash";
    if (category === "1階トイレ") return "toilet1";
    if (category === "2階トイレ") return "toilet2";
    return null;
  }
  if (scope === "equipment") {
    if (category === "暖房設備") return "heating";
    if (category === "換気設備") return "ventilation";
    if (category === "電気配線") return "wiring";
    if (category === "あかりプラン") return "lighting";
    return null;
  }
  if (scope === "interiorColor") {
    if (category === "浴室枠") return "bath";
    if (category === "玄関枠") return "exterior";
    return "interior";
  }
  if (scope === "room") return "interior";
  return null;
}

async function listCollection(store: ReturnType<typeof getStore>, collection: string, projectId?: string) {
  const { blobs } = await store.list({ prefix: collection + "/" });
  const items = await Promise.all(blobs.map((b) => store.get(b.key, { type: "json" })));
  return (items.filter(Boolean) as any[]).filter(
    (x) => !x.deletedAt && (projectId ? x.projectId === projectId : true)
  );
}

function fileOf(f: any) {
  return { url: f.url, contentType: f.contentType || "", name: f.name || f.fileName || "" };
}

export default async (req: Request, context: Context) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });

  const store = getStore("staffData");
  const url = new URL(req.url);
  let body: any = {};
  if (req.method === "POST") {
    try { body = await req.json(); } catch { return json({ error: "invalid_json" }, 400); }
  }
  const projectId = String((req.method === "POST" ? body.p : url.searchParams.get("p")) || "");
  const token = String((req.method === "POST" ? body.t : url.searchParams.get("t")) || "");
  if (!projectId || !token) return json({ error: "missing_link" }, 400);

  const project: any = await store.get(`projects/${projectId}`, { type: "json" });
  if (!project) {
    return json({ error: "project_not_found", debug: { projectId } }, 403);
  }
  if (project.deletedAt) {
    return json({ error: "project_deleted" }, 403);
  }
  if (!project.noteToken) {
    return json({ error: "token_not_set", debug: { projectId, hasToken: !!project.noteToken } }, 403);
  }
  if (project.noteToken !== token) {
    return json({ error: "token_mismatch", debug: { projectId, expected: project.noteToken?.slice(0, 8), got: token?.slice(0, 8) } }, 403);
  }

  // ---------- お客様からの書き込み ----------
  if (req.method === "POST") {
    if (body.action === "decide") {
      const cat = String(body.category || "");
      const status = String(body.status || "");
      if (!NOTE_CATS.some((c) => c.id === cat)) return json({ error: "unknown_category" }, 400);
      if (!["検討中", "仮決定", "決定"].includes(status)) return json({ error: "invalid_status" }, 400);
      const id = `${projectId}__${cat}`;
      const now = new Date().toISOString();
      const doc = { id, projectId, category: cat, status, by: "お客様", decidedAt: now, updatedAt: now };
      await store.setJSON(`noteDecisions/${id}`, doc);
      return json({ ok: true, decision: doc });
    }
    if (body.action === "message") {
      const text = String(body.text || "").trim().slice(0, 2000);
      if (!text) return json({ error: "empty" }, 400);
      const id = genId("msg");
      const now = new Date().toISOString();
      const doc = {
        id, projectId, content: text, sender: (project.customer || "お客様") + "（おうちノート）",
        fromCustomer: true, createdAt: now, updatedAt: now,
      };
      await store.setJSON(`messages/${id}`, doc);
      return json({ ok: true, message: doc });
    }
    return json({ error: "unknown_action" }, 400);
  }

  // ---------- お客様画面に表示するデータ ----------
  const [specPhotos, notes, attachments, album, messages, reservations, decisions, notices] = await Promise.all([
    listCollection(store, "specPhotos", projectId),
    listCollection(store, "meetingNotes", projectId),
    listCollection(store, "attachments", projectId),
    listCollection(store, "albumPhotos", projectId),
    listCollection(store, "messages", projectId),
    listCollection(store, "reservations", projectId),
    listCollection(store, "noteDecisions", projectId),
    listCollection(store, "noteNotices"),
  ]);

  const reflectedNotes = notes.filter((n) => n.reflected);
  const timelineByCat: Record<string, any[]> = {};
  const push = (cat: string | null, item: any) => {
    if (!cat) return;
    (timelineByCat[cat] = timelineByCat[cat] || []).push(item);
  };

  for (const p of specPhotos) {
    if (!p.reflected || p.kind === "note" || !p.url) continue;
    push(noteCatFor(p.scope, p.category), {
      type: p.kind === "planboard" ? "planboard" : "photo",
      at: p.createdAt || "",
      label: p.category || "",
      file: fileOf(p),
      source: p.source || null,
      contentType: p.contentType || "",
    });
  }
  for (const n of reflectedNotes) {
    const sp = n.specPart || {};
    push(noteCatFor(sp.scope, sp.category), {
      type: "note",
      at: (n.date ? n.date + "T12:00:00" : "") || n.createdAt || "",
      date: n.date || (n.createdAt || "").slice(0, 10),
      title: n.title || "",
      decided: n.decided != null ? n.decided : n.content || "",
      open: n.open || "",
      files: (n.files || []).map(fileOf),
    });
  }

  const plans = attachments
    .filter((a) => a.kind === "plan")
    .sort((a, b) => String(a.uploadedAt || "").localeCompare(String(b.uploadedAt || "")))
    .map((a) => ({ ...fileOf(a), date: a.uploadedAt || "" }));

  const decisionByCat: Record<string, any> = {};
  for (const d of decisions) decisionByCat[d.category] = d;

  const categories = NOTE_CATS.map((c) => {
    const items = (timelineByCat[c.id] || []).sort((a, b) => String(a.at).localeCompare(String(b.at)));
    const hasContent = c.id === "plan" ? plans.length > 0 : items.length > 0;
    const d = decisionByCat[c.id];
    return {
      ...c,
      status: c.id === "plan" ? (hasContent ? "図面あり" : "準備中") : d ? d.status : hasContent ? "検討中" : "準備中",
      decidedAt: d ? d.decidedAt : null,
      items,
      count: c.id === "plan" ? plans.length : items.length,
    };
  });

  const today = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
  const resv = reservations
    .map((r) => ({ type: r.type, date: r.date, startTime: r.startTime, endTime: r.endTime, staff: r.staff || "" }))
    .sort((a, b) => (a.date + a.startTime).localeCompare(b.date + b.startTime));

  return json({
    project: {
      name: project.name || "",
      customer: project.customer || "",
      progressTag: project.progressTag || "",
      exteriorSpecValues: project.exteriorSpecValues || {},
    },
    today,
    categories,
    plans,
    notes: reflectedNotes
      .map((n) => ({
        date: n.date || (n.createdAt || "").slice(0, 10),
        createdAt: n.createdAt || "",
        title: n.title || "",
        decided: n.decided != null ? n.decided : n.content || "",
        open: n.open || "",
        part: (n.specPart && n.specPart.label) || "",
        files: (n.files || []).map(fileOf),
      }))
      .sort((a, b) => (b.date + b.createdAt).localeCompare(a.date + a.createdAt)),
    album: album
      .filter((a) => a.url)
      .map((a) => ({ ...fileOf(a), kind: a.kind || "album", createdAt: a.createdAt || "" }))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    messages: messages
      .map((m) => ({ content: m.content || "", sender: m.sender || "", fromCustomer: !!m.fromCustomer, createdAt: m.createdAt || "" }))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    reservations: resv,
    nextReservation: resv.find((r) => r.date >= today) || null,
    notices: notices
      .filter((x) => x.published !== false)
      .map((x) => ({
        kind: x.kind || "notice", tag: x.tag || "", title: x.title || "", body: x.body || "",
        linkLabel: x.linkLabel || "", linkUrl: x.linkUrl || "", order: Number(x.order || 0), createdAt: x.createdAt || "",
      }))
      .sort((a, b) => a.order - b.order || a.createdAt.localeCompare(b.createdAt)),
  });
};

export const config: Config = {
  path: "/api/note-data",
};
