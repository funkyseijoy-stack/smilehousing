import type { Context, Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";

// 住まいるアプリ（このサイト）と、おうちノート本体（strong-piroshki-295252、
// customer-data.mts / customer-inbox.mts）をつなぐ橋渡し関数。
// スタッフのCookie認証はドメインをまたげないため、既存のスタッフ合い言葉を
// ヘッダーで渡してサーバー間から直接おうちノートのAPIを呼び出す。

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PATCH, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Staff-Token",
};

// staff-data.mts と同じ合い言葉（住まいるアプリ内の認証）
const STAFF_PASSPHRASE = "sumairu2026";

const OKAINOTE_BASE = "https://strong-piroshki-295252.netlify.app";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

function sanitizeCustomerId(value: string): string {
  return String(value || "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 80) || "customer";
}

function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

async function okaiFetch(path: string, init?: RequestInit): Promise<Response> {
  // おうちノート本体（strong-piroshki）の staff-auth.mts には、既存のスタッフ合い言葉
  // （STAFF_ACCESS_CODE、住まいるアプリの合い言葉と同じ値）をヘッダーで渡して認証する。
  return fetch(`${OKAINOTE_BASE}${path}`, {
    ...init,
    headers: {
      ...(init?.headers || {}),
      "x-staff-code": STAFF_PASSPHRASE,
    },
  });
}

type LinkRecord = { customerId: string; accessToken: string; customerName: string; url: string; createdAt: string; updatedAt: string };

async function getLink(store: ReturnType<typeof getStore>, projectId: string): Promise<LinkRecord | null> {
  return (await store.get(`okainoteLinks/${projectId}`, { type: "json" })) as LinkRecord | null;
}

export default async (req: Request, context: Context) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  const token = req.headers.get("x-staff-token");
  if (token !== STAFF_PASSPHRASE) {
    return json({ error: "unauthorized" }, 401);
  }

  const store = getStore("staffData");
  const url = new URL(req.url);

  if (req.method === "GET") {
    const projectId = sanitizeCustomerId(url.searchParams.get("projectId") || "");
    const resource = url.searchParams.get("resource") || "data";
    if (!projectId) return json({ error: "projectId_required" }, 400);

    if (resource === "data") {
      const res = await okaiFetch(`/api/customer-data?customerId=${encodeURIComponent(projectId)}`);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) return json({ error: "okainote_unavailable", detail: data }, 502);
      const link = await getLink(store, projectId);
      return json({ customer: data.customer, link: link ? { url: link.url, customerName: link.customerName } : null });
    }

    if (resource === "inbox") {
      const res = await okaiFetch(`/api/customer-inbox?customerId=${encodeURIComponent(projectId)}`);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) return json({ error: "okainote_unavailable", detail: data }, 502);
      // メッセージのやり取り（type: message）は住まいるアプリ側では連携対象外
      const entries = (data.entries || []).filter((entry: any) => entry && entry.type !== "message");
      return json({ entries });
    }

    return json({ error: "unknown_resource" }, 400);
  }

  let body: any = {};
  try {
    body = await req.json();
  } catch {
    return json({ error: "invalid_json" }, 400);
  }

  if (req.method === "PATCH") {
    const projectId = sanitizeCustomerId(body.projectId || "");
    const patch = body.patch;
    if (!projectId) return json({ error: "projectId_required" }, 400);
    if (!patch || typeof patch !== "object") return json({ error: "patch_required" }, 400);
    const res = await okaiFetch(`/api/customer-data?customerId=${encodeURIComponent(projectId)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return json({ error: "okainote_unavailable", detail: data }, 502);
    return json({ customer: data.customer });
  }

  if (req.method === "POST") {
    const action = body.action;
    const projectId = sanitizeCustomerId(body.projectId || "");
    if (!projectId) return json({ error: "projectId_required" }, 400);

    if (action === "ensureLink") {
      const customerName = String(body.customerName || "お客様").slice(0, 100);
      let link = await getLink(store, projectId);
      const accessToken = link?.accessToken || randomToken();
      const res = await okaiFetch(`/api/customer-data?customerId=${encodeURIComponent(projectId)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ customerAccessToken: accessToken, customerName }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) return json({ error: "okainote_unavailable", detail: data }, 502);
      const now = new Date().toISOString();
      link = {
        customerId: projectId,
        accessToken,
        customerName,
        url: `${OKAINOTE_BASE}/?customer=${encodeURIComponent(projectId)}&access=${encodeURIComponent(accessToken)}&name=${encodeURIComponent(customerName)}`,
        createdAt: link?.createdAt || now,
        updatedAt: now,
      };
      await store.setJSON(`okainoteLinks/${projectId}`, link);
      return json({ link });
    }

    if (action === "markInboxRead") {
      const id = String(body.id || "");
      if (!id) return json({ error: "id_required" }, 400);
      const res = await okaiFetch(`/api/customer-inbox`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, read: true }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) return json({ error: "okainote_unavailable", detail: data }, 502);
      return json({ ok: true });
    }

    if (action === "postInboxEntry") {
      // 打合せ記録・設備仕様写真などを「おうちノート」の受信箱（customer-inbox）へ
      // スタッフから直接投稿する（住まいるアプリの「反映」操作から呼ばれる）。
      const entry = body.entry;
      if (!entry || typeof entry !== "object") return json({ error: "entry_required" }, 400);
      const customerName = String(body.customerName || "お客様").slice(0, 100);
      const res = await okaiFetch(`/api/customer-inbox`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: entry.type,
          customerId: projectId,
          customerName,
          direction: "staff_to_customer",
          text: entry.text || "",
          images: Array.isArray(entry.images) ? entry.images : [],
          meta: entry.meta || {},
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) return json({ error: "okainote_unavailable", detail: data }, 502);
      return json({ id: data.id });
    }

    return json({ error: "unknown_action" }, 400);
  }

  return json({ error: "method_not_allowed" }, 405);
};

export const config: Config = {
  path: "/api/okainote-bridge",
};
