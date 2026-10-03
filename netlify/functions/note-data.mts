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

// 追加見積り・ご家族家電・家づくりリスト・A's 3Dリンクは、今のところ住まいるアプリの
// 「おうちノート連携」タブが旧おうちノート本体（strong-piroshki-295252、customer-data.mts）
// に保存しているデータをそのまま使っている（staffDataには無い）。新おうちノートでも
// 表示できるよう、ここから同じAPIをサーバー間で直接読み出す（okainote-bridge.mtsと同じ
// 合言葉・仕組み）。取得できなくても他の表示は止めたくないので、失敗時はnullを返すだけにする。
const OKAINOTE_BASE = "https://strong-piroshki-295252.netlify.app";
const STAFF_PASSPHRASE = "sumairu2026"; // 住まいるアプリ内の他Functionと同じ合言葉（変更時は全ファイルで揃えること）

async function fetchOkaiCustomerExtras(projectId: string): Promise<any> {
  try {
    const res = await fetch(`${OKAINOTE_BASE}/api/customer-data?customerId=${encodeURIComponent(projectId)}`, {
      headers: { "x-staff-code": STAFF_PASSPHRASE },
    });
    if (!res.ok) return null;
    const data = await res.json().catch(() => null);
    return (data && data.customer) || null;
  } catch {
    return null;
  }
}

// お客様画面の「設備仕様」一覧。玄関は外部に統合している。
// match: [scope, category|null]（nullはそのscopeの全カテゴリー）
const NOTE_CATS = [
  { id: "exterior", name: "外部", sub: "外壁・屋根・破風・サッシ・玄関", icon: "house" },
  { id: "kitchen", name: "キッチン", sub: "プランボード・設備仕様", icon: "kitchen" },
  { id: "bath", name: "お風呂", sub: "プランボード・設備仕様", icon: "bath" },
  { id: "wash", name: "洗面", sub: "洗面台・ミラー・収納", icon: "wash" },
  { id: "toilet", name: "トイレ", sub: "1階・2階", icon: "toilet" },
  { id: "climate", name: "暖房・換気", sub: "暖房機器・換気方式", icon: "heating" },
  { id: "electric", name: "電気・あかり", sub: "配線・照明計画", icon: "plug" },
  { id: "interior", name: "インテリアメイン", sub: "床・建具・クロス・配色", icon: "sofa" },
  // 部屋別インテリア。部屋ごとに分けて表示し、「仮決定／決定」も部屋単位で受け付ける
  { id: "rooms", name: "各部屋", sub: "天井・壁・アクセント", icon: "room" },
];

// 統合前（12項目だった頃）の項目IDで保存済みのお客様の「仮決定／決定」を、新しい項目IDに読み替える
const LEGACY_CAT_MAP: Record<string, string> = {
  toilet1: "toilet", toilet2: "toilet", heating: "climate", ventilation: "climate", wiring: "electric", lighting: "electric",
};

const ROOM_CAT_LABELS: Record<string, string> = { ceiling: "天井", wall: "壁", accent: "アクセント" };
// 各部位の表示名。部屋別インテリアは「部屋名・天井/壁/アクセント」の形にする
function partLabel(project: any, scope?: string, category?: string | null, roomId?: string | null): string {
  if (scope === "room") {
    const room = (project.rooms || []).find((r: any) => r.id === roomId);
    const custom = (project.roomCatsCustom || []).find((c: any) => c.id === category);
    const cl = custom ? custom.name : ROOM_CAT_LABELS[String(category)] || category || "";
    return (room ? room.name : "部屋") + "・" + cl;
  }
  return category || "";
}

function noteCatFor(scope?: string, category?: string | null): string | null {
  if (!scope) return null;
  if (scope === "exterior") return "exterior";
  if (scope === "facility") {
    if (category === "キッチン") return "kitchen";
    if (category === "お風呂") return "bath";
    if (category === "洗面" || category === "脱衣室") return "wash";
    if (category === "1階トイレ" || category === "2階トイレ") return "toilet";
    return null;
  }
  if (scope === "equipment") {
    if (category === "暖房設備" || category === "換気設備") return "climate";
    if (category === "電気配線" || category === "あかりプラン") return "electric";
    return null;
  }
  if (scope === "interiorColor") {
    if (category === "浴室枠") return "bath";
    if (category === "玄関枠") return "exterior";
    return "interior";
  }
  if (scope === "room") return "rooms";
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
      const now = new Date().toISOString();
      let id = `${projectId}__${cat}`;
      let roomId: string | null = null;
      if (cat === "rooms") {
        // 各部屋は部屋ごとに決定する（部屋IDがこの案件の部屋であることを確認する）
        roomId = String(body.roomId || "");
        if (!(project.rooms || []).some((r: any) => r.id === roomId)) return json({ error: "unknown_room" }, 400);
        id = `${projectId}__rooms__${roomId}`;
      }
      const doc: any = { id, projectId, category: cat, status, by: "お客様", decidedAt: now, updatedAt: now };
      if (roomId) doc.roomId = roomId;
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
  const [specPhotos, notes, attachments, album, messages, reservations, decisions, notices, okaiCustomer] = await Promise.all([
    listCollection(store, "specPhotos", projectId),
    listCollection(store, "meetingNotes", projectId),
    listCollection(store, "attachments", projectId),
    listCollection(store, "albumPhotos", projectId),
    listCollection(store, "messages", projectId),
    listCollection(store, "reservations", projectId),
    listCollection(store, "noteDecisions", projectId),
    listCollection(store, "noteNotices"),
    fetchOkaiCustomerExtras(projectId),
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
      label: partLabel(project, p.scope, p.category, p.roomId),
      roomId: p.roomId || null,
      file: fileOf(p),
      source: p.source || null,
      contentType: p.contentType || "",
    });
  }
  for (const n of reflectedNotes) {
    const sp = n.specPart || {};
    push(noteCatFor(sp.scope, sp.category), {
      type: "note",
      label: partLabel(project, sp.scope, sp.category, sp.roomId),
      roomId: sp.roomId || null,
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
  for (const d of decisions.slice().sort((a, b) => String(a.decidedAt || "").localeCompare(String(b.decidedAt || "")))) {
    decisionByCat[LEGACY_CAT_MAP[d.category] || d.category] = d; // 新しい日付のものが残る
  }

  // 各部屋：部屋ごとに写真・記録と決定状況をまとめる（内容のある部屋だけをお客様に見せる）
  const roomDecisionById: Record<string, any> = {};
  for (const d of decisions) if (d.category === "rooms" && d.roomId) roomDecisionById[d.roomId] = d;
  const roomItemsById: Record<string, any[]> = {};
  for (const it of timelineByCat["rooms"] || []) {
    if (!it.roomId) continue;
    (roomItemsById[it.roomId] = roomItemsById[it.roomId] || []).push(it);
  }
  const buildRoomsCategory = (c: any) => {
    const rooms = (project.rooms || [])
      .map((r: any) => {
        const items = (roomItemsById[r.id] || []).sort((a, b) => String(a.at).localeCompare(String(b.at)));
        const d = roomDecisionById[r.id];
        return {
          id: r.id, name: r.name || "部屋", accentNote: r.accentNote || "",
          items, count: items.length,
          status: d ? d.status : items.length ? "検討中" : "準備中",
          decidedAt: d ? d.decidedAt : null,
        };
      })
      .filter((r: any) => r.status !== "準備中");
    const decidedN = rooms.filter((r: any) => r.status === "決定").length;
    const status = !rooms.length ? "準備中"
      : decidedN === rooms.length ? "決定"
      : decidedN === 0 && rooms.some((r: any) => r.status === "仮決定") ? "仮決定"
      : "検討中";
    return {
      ...c,
      sub: rooms.length ? `${decidedN}/${rooms.length}部屋 決定` : c.sub,
      status, decidedAt: null, items: [], rooms,
      count: rooms.reduce((n: number, r: any) => n + r.count, 0),
    };
  };

  const categories = NOTE_CATS.map((c) => {
    if (c.id === "rooms") return buildRoomsCategory(c);
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
  // 住まいるアプリの「予約」タブ（reservationsコレクション）に加えて、おうちノート連携タブの
  // 「予約状況」カードから手動で追加した予約（nextBookings、旧おうちノート本体に保存）も
  // 合わせて表示する。重複を避けるため、日付+開始時刻が同じものは1件にまとめる。
  const okaiBookings = ((okaiCustomer && okaiCustomer.nextBookings) || []).map((b: any) => ({
    type: b.service || "", date: b.date || "", startTime: b.time || "", endTime: b.endTime || "", staff: "",
  }));
  const seenResv = new Set<string>();
  const resv = reservations
    .map((r) => ({ type: r.type, date: r.date, startTime: r.startTime, endTime: r.endTime, staff: r.staff || "" }))
    .concat(okaiBookings)
    .filter((r) => {
      const key = r.date + "|" + r.startTime;
      if (seenResv.has(key)) return false;
      seenResv.add(key);
      return true;
    })
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
    // 「おうちノート連携」タブ（旧おうちノート本体と橋渡しされている項目）。表示のみで、
    // お客様からの回答・更新はまだ今の（旧）おうちノートの画面で行う。
    estimates: ((okaiCustomer && okaiCustomer.customerEstimates) || []).map((x: any) => ({
      title: x.title || "", amount: x.amount || "", note: x.note || "",
      customerResponse: x.customerResponse || "未回答", createdAt: x.createdAt || "",
    })),
    familyProfile: okaiCustomer && okaiCustomer.customerProfile ? {
      familyMembers: okaiCustomer.customerProfile.familyMembers || [],
      appliances: okaiCustomer.customerProfile.appliances || [],
      bringIns: okaiCustomer.customerProfile.bringIns || [],
    } : null,
    considerations: ((okaiCustomer && okaiCustomer.considerations) || []).map((x: any) => ({
      title: x.title || "", note: x.note || "", status: x.status || "検討中", createdAt: x.createdAt || "",
    })),
    ace3dUrl: (okaiCustomer && okaiCustomer.customerLinks && okaiCustomer.customerLinks.ace3dUrl) || "",
  });
};

export const config: Config = {
  path: "/api/note-data",
};
