import type { Context, Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";
import { sendTaskAssignedMail, sendTaskDoneMails, queueTaskNotice, isQuietHourJst } from "../lib/task-mail.mts";

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
];

function genId() {
  return "s" + Date.now().toString(36) + Math.random().toString(36).slice(2, 9);
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
    if (body.replace) {
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
      const quiet = isQuietHourJst();
      const notify = (role: "assignee" | "checker", name: string) =>
        (quiet ? queueTaskNotice(store, doc, role, name, by) : sendTaskAssignedMail(store, doc, role, name, by)).catch(() => false);
      if (doc.assignee && doc.assignee !== by && doc.assignee !== (prevTask && prevTask.assignee)) {
        jobs.push(notify("assignee", doc.assignee));
      }
      if (doc.checker && doc.checker !== by && doc.checker !== (prevTask && prevTask.checker)) {
        jobs.push(notify("checker", doc.checker));
      }
      // 「完了」になったら、社長・朋子・依頼者へ報告する
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
