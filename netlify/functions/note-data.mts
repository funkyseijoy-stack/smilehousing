import type { Context, Config } from "@netlify/functions";
import { sendNotifyMail } from "../lib/google.mts";
import { getExtras, saveExtras } from "../lib/note-extras.mts";
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

// お家のイメージの「場所」タグ。住まいるアプリ側（public/app/index.html の IMAGE_PLACES）と
// public/note/index.html には同じ内容があるので、変更時は3か所とも直すこと。
const IMAGE_PLACES = ["外観", "玄関", "LDK", "キッチン", "お風呂", "洗面・脱衣", "トイレ", "階段", "寝室", "子供部屋", "その他"];
const IMAGE_MAX_BYTES = 4 * 1024 * 1024; // 1枚あたり。画面側で長辺1600pxに縮小してから送る
const IMAGE_MAX_PER_PROJECT = 200; // お客様が追加できる枚数の上限（案件ごと）

function imageOf(x: any) {
  return { id: x.id, url: x.url, place: x.place || "その他", by: x.by === "customer" ? "customer" : "staff", createdAt: x.createdAt || "" };
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
      // スタッフへ通知メール（失敗してもメッセージ送信自体は成功扱い）
      await sendNotifyMail(
        `【おうちノート】${project.customer || "お客様"}様からメッセージが届きました`,
        `${project.customer || "お客様"}様（${project.name || ""}）から、おうちノートでメッセージが届きました。\n\n${text}\n\n住まいるアプリの「メッセージ」から返信できます。`
      );
      return json({ ok: true, message: doc });
    }
    // ご家族・家電・持ち込み品（お客様が入力する）
    if (body.action === "profileSave") {
      const src = body.profile && typeof body.profile === "object" ? body.profile : {};
      const clean = (v: any) => String(v == null ? "" : v).trim().slice(0, 60);
      const rows = (arr: any, keys: string[]) =>
        (Array.isArray(arr) ? arr : []).slice(0, 20)
          .map((r: any) => { const o: any = {}; for (const k of keys) o[k] = clean(r && r[k]); return o; })
          .filter((o: any) => o.name);
      const profile = {
        familyMembers: rows(src.familyMembers, ["name", "heightCm"]),
        appliances: rows(src.appliances, ["name", "model", "size"]),
        bringIns: rows(src.bringIns, ["name", "width", "depth", "height"]),
      };
      const extras: any = await getExtras(store, projectId);
      if (!extras) return json({ error: "unavailable" }, 502);
      extras.customerProfile = { ...(extras.customerProfile || {}), ...profile };
      await saveExtras(store, extras);
      await sendNotifyMail(
        `【おうちノート】${project.customer || "お客様"}様がご家族・家電・持ち込み品を更新しました`,
        `${project.customer || "お客様"}様（${project.name || ""}）が、おうちノートで「ご家族・家電・持ち込み品」を入力・更新しました。\n\n住まいるアプリの「おうちノート連携」タブで確認できます。`
      );
      return json({ ok: true, profile });
    }
    // 追加見積りの「承認」「見送り」（お客様の回答。「承認依頼」に戻すこともできる）
    if (body.action === "estimateRespond") {
      const estId = String(body.id || "");
      const response = String(body.response || "");
      if (!estId || !["承認", "見送り", "未回答"].includes(response)) return json({ error: "invalid_request" }, 400);
      const extras: any = await getExtras(store, projectId);
      if (!extras) return json({ error: "unavailable" }, 502);
      const list: any[] = extras.customerEstimates || [];
      const item = list.find((x) => x.id === estId);
      if (!item) return json({ error: "not_found" }, 404);
      const pending = item.estimateState ? item.estimateState === "金額確認中" : !String(item.amount || "").trim();
      if (pending) return json({ error: "amount_pending" }, 400);
      const now = new Date().toISOString();
      item.customerResponse = response;
      item.customerRespondedAt = response === "未回答" ? "" : now;
      item.estimateState = response === "承認" ? "承認済み" : response === "見送り" ? "見送り" : "承認依頼";
      item.updated = now;
      await saveExtras(store, extras);
      if (response !== "未回答") {
        await sendNotifyMail(
          `【おうちノート】${project.customer || "お客様"}様が追加見積りを「${response === "承認" ? "承認" : "見送り"}」しました`,
          `${project.customer || "お客様"}様（${project.name || ""}）が、追加見積り「${item.title || ""}」${item.amount ? "（" + item.amount + "）" : ""}を「${response === "承認" ? "承認" : "見送り"}」しました。\n\n住まいるアプリの「おうちノート連携」タブで確認できます。`
        );
      }
      return json({ ok: true, id: estId, customerResponse: item.customerResponse, estimateState: item.estimateState, customerRespondedAt: item.customerRespondedAt });
    }
    // お家のイメージ（アルバムとは別に、お客様とスタッフが双方で写真を追加できる場所）。
    // お客様は自分が追加した写真だけ削除できる（スタッフの写真は消せない）。
    if (body.action === "imageAdd") {
      const place = String(body.place || "");
      if (!IMAGE_PLACES.includes(place)) return json({ error: "unknown_place" }, 400);
      const m = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/.exec(String(body.dataUrl || ""));
      if (!m) return json({ error: "invalid_image" }, 400);
      const contentType = m[1];
      let bytes: Uint8Array;
      try { bytes = Uint8Array.from(Buffer.from(m[2], "base64")); } catch { return json({ error: "invalid_base64" }, 400); }
      if (!bytes.length) return json({ error: "invalid_image" }, 400);
      if (bytes.length > IMAGE_MAX_BYTES) return json({ error: "too_large" }, 413);
      const existing = await listCollection(store, "imageBoard", projectId);
      if (existing.filter((x) => x.by === "customer").length >= IMAGE_MAX_PER_PROJECT) return json({ error: "limit_reached" }, 429);
      const photoStore = getStore("customerPhotos");
      const key = "p" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
      await photoStore.set(`${projectId}/${key}`, bytes, { metadata: { contentType } });
      const id = genId("img");
      const now = new Date().toISOString();
      const doc = {
        id, projectId, place, by: "customer", contentType,
        url: `/api/get-photo?slug=${encodeURIComponent(projectId)}&key=${encodeURIComponent(key)}`,
        fileName: String(body.fileName || "").slice(0, 120), createdAt: now, updatedAt: now,
      };
      await store.setJSON(`imageBoard/${id}`, doc);
      return json({ ok: true, image: imageOf(doc) });
    }
    if (body.action === "imageDelete") {
      const id = String(body.id || "");
      const doc: any = id ? await store.get(`imageBoard/${id}`, { type: "json" }) : null;
      if (!doc || doc.projectId !== projectId || doc.deletedAt) return json({ error: "not_found" }, 404);
      if (doc.by !== "customer") return json({ error: "forbidden" }, 403);
      const now = new Date().toISOString();
      await store.setJSON(`imageBoard/${id}`, { ...doc, deletedAt: now, updatedAt: now });
      return json({ ok: true });
    }
    return json({ error: "unknown_action" }, 400);
  }

  // ---------- お客様画面に表示するデータ ----------
  const [specPhotos, notes, attachments, album, messages, reservations, decisions, notices, okaiCustomer, imageBoard] = await Promise.all([
    listCollection(store, "specPhotos", projectId),
    listCollection(store, "meetingNotes", projectId),
    listCollection(store, "attachments", projectId),
    listCollection(store, "albumPhotos", projectId),
    listCollection(store, "messages", projectId),
    listCollection(store, "reservations", projectId),
    listCollection(store, "noteDecisions", projectId),
    listCollection(store, "noteNotices"),
    getExtras(store, projectId),
    listCollection(store, "imageBoard", projectId),
  ]);

  const specBadge = (b: any) => ({ contract: !!(b && b.contract), quote: !!(b && b.quote) });
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
      // 「契約時仕様」「見積もり仕様」の分類（お客様画面のタブ用。社内タスクなどのバッジは渡さない）
      spec: specBadge(p.badges),
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
      spec: specBadge(n.badges),
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
    imagePlaces: IMAGE_PLACES,
    images: imageBoard
      .filter((x) => x.url)
      .map(imageOf)
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
      id: x.id || "", title: x.title || "", amount: x.amount || "", note: x.note || "",
      customerResponse: x.customerResponse || "未回答", estimateState: x.estimateState || "", createdAt: x.createdAt || "",
    })),
    familyProfile: okaiCustomer && okaiCustomer.customerProfile ? {
      familyMembers: okaiCustomer.customerProfile.familyMembers || [],
      appliances: okaiCustomer.customerProfile.appliances || [],
      bringIns: okaiCustomer.customerProfile.bringIns || [],
    } : null,
    considerations: ((okaiCustomer && okaiCustomer.considerations) || []).map((x: any) => ({
      title: x.title || "", note: x.note || "", status: x.status || "検討中", createdAt: x.createdAt || "",
    })),
    // 家づくりの進み具合（スタッフが「おうちノート連携」タブで入力。on:false や未入力なら出さない）
    houseProgress: (() => {
      const hp = okaiCustomer && okaiCustomer.houseProgress;
      if (!hp || hp.on === false || !Array.isArray(hp.steps)) return null;
      const steps = hp.steps.slice(0, 20).map((x: any) => ({ name: String((x && x.name) || "").slice(0, 40), date: String((x && x.date) || "").slice(0, 40) })).filter((x: any) => x.name);
      if (!steps.length) return null;
      const cur = typeof hp.current === "number" && hp.current >= 0 && hp.current < steps.length ? hp.current : -1;
      return { steps, current: cur };
    })(),
    ace3dUrl: (okaiCustomer && okaiCustomer.customerLinks && okaiCustomer.customerLinks.ace3dUrl) || "",
  });
};

export const config: Config = {
  path: "/api/note-data",
};
