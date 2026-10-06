import { getStore } from "@netlify/blobs";

// 追加見積り・家づくりリスト・ご家族・家電・持ち込み品・A's 3Dリンクなどを、
// 住まいるアプリ本体のデータ置き場（staffData の noteExtras/<案件ID>）に保存する。
// 以前は旧おうちノート本体（strong-piroshki-295252）に保存していたため、
// 最初に開いたときだけ旧側から1回だけ写す（旧側のデータは消さない）。
const OLD_BASE = "https://strong-piroshki-295252.netlify.app";
const STAFF_PASSPHRASE = "sumairu2026"; // 住まいるアプリ内の他Functionと同じ合言葉（変更時は全ファイルで揃えること）

type Store = ReturnType<typeof getStore>;

export const EXTRAS_KEYS = ["customerEstimates", "considerations", "customerProfile", "customerLinks", "nextBookings", "houseProgress"];

// 旧側から取得。取得できたら customer（無ければ空）を、404なら {}（旧側に記録なし）を返し、
// 通信エラー等のときは null（＝まだ写せていない）を返す。
async function fetchOldCustomer(projectId: string): Promise<any | null> {
  try {
    const res = await fetch(`${OLD_BASE}/api/customer-data?customerId=${encodeURIComponent(projectId)}`, {
      headers: { "x-staff-code": STAFF_PASSPHRASE },
    });
    if (res.status === 404) return {};
    if (!res.ok) return null;
    const data = await res.json().catch(() => null);
    if (!data) return null;
    return data.customer || {};
  } catch {
    return null;
  }
}

export async function getExtras(store: Store, projectId: string): Promise<any | null> {
  const key = `noteExtras/${projectId}`;
  const existing = await store.get(key, { type: "json" });
  if (existing) return existing;
  const old = await fetchOldCustomer(projectId);
  if (old === null) return null; // 旧側と通信できなかった。保存せず、次に開いたときにやり直す
  const now = new Date().toISOString();
  const doc: any = { id: projectId, projectId, importedFromOldAt: now, updatedAt: now };
  for (const k of EXTRAS_KEYS) if (old[k] !== undefined) doc[k] = old[k];
  doc.customerEstimates = Array.isArray(doc.customerEstimates) ? doc.customerEstimates : [];
  doc.considerations = Array.isArray(doc.considerations) ? doc.considerations : [];
  doc.nextBookings = Array.isArray(doc.nextBookings) ? doc.nextBookings : [];
  // 一度写したら、以後は旧側を見ない
  await store.setJSON(key, doc);
  return doc;
}

export async function saveExtras(store: Store, doc: any): Promise<void> {
  doc.updatedAt = new Date().toISOString();
  await store.setJSON(`noteExtras/${doc.id}`, doc);
}
