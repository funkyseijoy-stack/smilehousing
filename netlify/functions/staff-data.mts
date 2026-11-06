import type { Context, Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";
import { sendTaskAssignedMail, sendTaskDoneMails, sendTaskReviewMail, queueTaskNotice, isQuietHourJst, holdsOnOffDays, isOffDayJst, holdTaskNoticeForWorkday } from "../lib/task-mail.mts";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Staff-Token",
};

// staff-auth.mts と同じ値にしてください。
const STAFF_PASSPHRASE = "sumairu2026";

// このNetlify版アプリで扱えるコレクション名（住まいるアプリ本体のdb.collection名と合わせている）
const ALLOWED_COLLECTIONS = [
  "customers", "cases", "vendors", "meetingNotes", "specs",
  "confirmations", "furniture", "checklists", "materials",
  "customerTasks", "configLists", "tabItems",
  // 住まいるアプリ本体（Netlify単独版）で使うコレクション
  "projects", "requests", "attachments", "activity", "tasks",
  "messages", "specPhotos", "confirmItems", "albumPhotos",
  "reservations", "settings",
  // 新おうちノート（/note/）用：お客様の仮決定・決定、お知らせ・豆知識
  "noteDecisions", "noteNotices",
  // お家のイメージ（お客様とスタッフが双方で追加する写真）
  "imageBoard",
  // 現場写真（スタッフ限定・リフォーム案件。お客様画面には出さない）
  "sitePhotos",
  // プランボードの書き込みデータ（元の絵・線・文字・貼った画像を分けて残し、保存したあとも直せるように）
  "pbLayers",
];

function genId() {
  return "s" + Date.now().toString(36) + Math.random().toString(36).slice(2, 9);
}

// ---- 3者マージ：base＝その端末が最後に受け取った内容、patch＝その端末が変えた項目、existing＝いまのサーバーの内容 ----
const js = (v: any) => (v === undefined ? "__undef__" : JSON.stringify(v));
const isIdArr = (a: any) => Array.isArray(a) && a.every((x) => x && typeof x === "object" && !Array.isArray(x) && x.id != null);
function merge3Arr(base: any[], mine: any[], theirs: any[]) {
  const bm = new Map(base.map((x) => [String(x.id), x]));
  const tm = new Map(theirs.map((x) => [String(x.id), x]));
  const out: any[] = [];
  const seen = new Set<string>();
  for (const m of mine) {
    const k = String(m.id); seen.add(k);
    const b = bm.get(k), t = tm.get(k);
    if (b && js(m) === js(b)) {
      // 自分は変えていない：ほかで消されていれば消す、ほかで変わっていればそちらを使う
      if (!t) continue;
      out.push(t);
    } else out.push(m);
  }
  // ほかの端末で足されたもの（自分の元にも、自分の今にも無い）は残す
  for (const t of theirs) { const k = String(t.id); if (!seen.has(k) && !bm.has(k)) { out.push(t); seen.add(k); } }
  return out;
}
function mergePatch(existing: any, patch: any, base: any, removed: string[]) {
  const doc: any = { ...existing };
  for (const k of Object.keys(patch)) {
    if (k === "id" || k === "updatedAt") continue;
    const mine = patch[k], b = base[k], t = existing[k];
    if (js(t) === js(b) || t === undefined) doc[k] = mine;
    else if (isIdArr(mine) && isIdArr(t) && (b === undefined || isIdArr(b))) doc[k] = merge3Arr(b || [], mine, t);
    else doc[k] = mine; // 同じ項目をほかの端末も変えていた：これまでどおり後から保存したほうを使う
  }
  for (const k of removed) {
    if (k === "id") continue;
    if (js(existing[k]) === js(base[k])) delete doc[k]; // ほかで変わっていなければ消す
  }
  return doc;
}

export default async (req: Request, context: Context) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  const token = req.headers.get("x-staff-token");
  if (token !== STAFF_PASSPHRASE) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }

  const store = getStore("staffData");

  if (req.method === "GET") {
    const url = new URL(req.url);
    const collection = url.searchParams.get("collection") || "";
    if (!ALLOWED_COLLECTIONS.includes(collection)) {
      return new Response(JSON.stringify({ error: "unknown_collection" }), {
        status: 400,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });
    }
    const { blobs } = await store.list({ prefix: collection + "/" });
    const items = await Promise.all(
      blobs.map(async (b) => {
        const data = await store.get(b.key, { type: "json" });
        return data;
      })
    );
    return new Response(JSON.stringify({ items: items.filter(Boolean) }), {
      status: 200,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json", "Cache-Control": "no-store" },
    });
  }

  let body: any = {};
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "invalid_json" }), {
      status: 400,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }

  const collection = body.collection;
  if (!ALLOWED_COLLECTIONS.includes(collection)) {
    return new Response(JSON.stringify({ error: "unknown_collection" }), {
      status: 400,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }

  if (req.method === "POST") {
    const id = genId();
    const now = new Date().toISOString();
    const doc = { id, ...(body.data || {}), createdAt: now, updatedAt: now };
    await store.setJSON(`${collection}/${id}`, doc);
    return new Response(JSON.stringify(doc), {
      status: 200,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }

  if (req.method === "PUT") {
    const id = body.id;
    if (!id) {
      return new Response(JSON.stringify({ error: "id_required" }), {
        status: 400,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });
    }
    const key = `${collection}/${id}`;
    // replace:true は Firestore の .set() と同じ「完全上書き」。住まいるアプリ本体は
    // クライアント側で常にドキュメント全体を組み立てて保存するため、こちらを使う。
    // 省略時（他アプリの既存の呼び出し）は従来通りマージ更新のまま。
    // タスクの担当者・確認者が新しく決まったら、その人へ個人のメールで知らせる（自分で自分に入れたときは送らない）。
    const prevTask: any = collection === "tasks" ? await store.get(key, { type: "json" }) : null;
    let doc;
    if (body.patch && typeof body.patch === "object") {
      // 変えた項目だけを送ってもらい、サーバーの最新に重ねる（3者マージ）。
      // 古い画面のまま保存して、ほかの端末で足した内容（初期の打合せ記録など）を消してしまう事故の対策。
      const existing: any = (await store.get(key, { type: "json", consistency: "strong" } as any)) || { id };
      doc = mergePatch(existing, body.patch, body.base || {}, Array.isArray(body.removed) ? body.removed : []);
      doc.id = id; doc.updatedAt = new Date().toISOString();
    } else if (body.replace) {
      doc = { ...(body.data || {}), id, updatedAt: new Date().toISOString() };
    } else {
      const existing = (await store.get(key, { type: "json" })) || { id };
      doc = { ...existing, ...(body.data || {}), id, updatedAt: new Date().toISOString() };
    }
    await store.setJSON(key, doc);
    if (collection === "tasks" && !doc.deletedAt && !doc.private) {
      const by = String(body.by || "");
      const jobs: Promise<any>[] = [];
      // 昼は都度メール、夜（18時〜翌9時）は翌朝9時にまとめて送る
      // 土日祝がお休みの人（山本さん）は、休みの日に入った分を次の平日の朝9時にまとめて送る
      const quiet = isQuietHourJst();
      let offDay: Promise<boolean> | null = null;
      const notify = async (role: "assignee" | "checker", name: string) => {
        try {
          if (quiet) return await queueTaskNotice(store, doc, role, name, by);
          if (holdsOnOffDays(name) && await (offDay ||= isOffDayJst())) return await holdTaskNoticeForWorkday(store, doc, role, name, by);
          return await sendTaskAssignedMail(store, doc, role, name, by);
        } catch { return false; }
      };
      if (doc.assignee && doc.assignee !== by && doc.assignee !== (prevTask && prevTask.assignee)) {
        jobs.push(notify("assignee", doc.assignee));
      }
      let checkerNotified = "";
      if (doc.checker && doc.checker !== by && doc.checker !== (prevTask && prevTask.checker)) {
        jobs.push(notify("checker", doc.checker));
        checkerNotified = doc.checker;
      }
      // 進捗が「○○確認依頼中」（社長確認依頼中・朋子確認依頼中など）に移ったら、その人へも知らせる
      // （確認者を選んだ保存で、すでに同じ人へ送った場合は重ねて送らない）
      // （旧名称「○○確認中」から新名称「○○確認依頼中」への自動移行では、重ねて送らない）
      const checkRe = /^(.+?)確認(?:依頼)?中$/;
      const m = String(doc.status || "").match(checkRe);
      const pm = String((prevTask && prevTask.status) || "").match(checkRe);
      const sameCheck = !!(m && pm && m[1] === pm[1]);
      if (m && doc.status !== (prevTask && prevTask.status) && !sameCheck && m[1] !== by && m[1] !== checkerNotified) {
        jobs.push(notify("checker", m[1]));
      }
      // 確認者が承認／差し戻しをしたら、担当者へ知らせる（review.at が変わったときだけ）
      if (doc.review && doc.review.at && doc.review.at !== (prevTask && prevTask.review && prevTask.review.at)) {
        jobs.push(sendTaskReviewMail(store, doc, by).catch(() => false));
      }
      // 「完了」になったら、選ばれた人へ報告する
      if (doc.status === "完了" && prevTask && prevTask.status !== "完了") {
        jobs.push(sendTaskDoneMails(store, doc, by).catch(() => false));
      }
      if (jobs.length) {
        const all = Promise.all(jobs);
        if (context && (context as any).waitUntil) (context as any).waitUntil(all); else await all;
      }
    }
    return new Response(JSON.stringify(doc), {
      status: 200,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }

  if (req.method === "DELETE") {
    const id = body.id;
    if (!id) {
      return new Response(JSON.stringify({ error: "id_required" }), {
        status: 400,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });
    }
    await store.delete(`${collection}/${id}`);
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }

  return new Response(JSON.stringify({ error: "method_not_allowed" }), {
    status: 405,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
};

export const config: Config = {
  path: "/api/staff-data",
};
