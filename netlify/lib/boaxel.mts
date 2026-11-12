// 収納プラン（IKEA ボーアクセル）の部品の一覧と、お客様のプランから部品・金額を数える処理。
// 使う所：/api/shuno（収納プランのページ /shuno/）と /api/note-data（おうちノートのメニューに出すかどうか）。
// 部品の一覧はスタッフが住まいるアプリの「業者・設定」で直す（settings/main.boaxel）。無いときは BOAXEL_DEFAULTS。
// 住まいるアプリの BOAXEL_DEFAULTS と、/shuno/ の画面の計算（colsForInner・標準の数・ブラケットの数え方）は**同じ内容**にしておくこと。

export const BOAXEL_TYPES = ["upright", "bracket", "shelf", "rail", "basket", "drawer", "shoe", "other"];
// ブラケットを付ける部品（棚板・カゴ）。上から同じ段で横につながった枚数＋1つ（間の縦レールのブラケットは共用）
export const BOAXEL_BRACKETED = ["shelf", "basket"];
export const BOAXEL_DEFAULTS: any[] = [
  { id: "up200", type: "upright", name: "縦レール（壁取り付け）", code: "", size: 200, price: "", max: 8 },
  { id: "up120", type: "upright", name: "縦レール（壁取り付け）", code: "", size: 120, price: "", max: 5 },
  { id: "up80", type: "upright", name: "縦レール（壁取り付け）", code: "", size: 80, price: "", max: 3 },
  { id: "br", type: "bracket", name: "ブラケット", code: "", size: "", price: "" },
  { id: "sh60", type: "shelf", name: "棚板", code: "", size: 60, price: "" },
  { id: "sh80", type: "shelf", name: "棚板", code: "", size: 80, price: "" },
  { id: "ba60", type: "basket", name: "カゴ", code: "", size: 60, price: "" },
  { id: "ba80", type: "basket", name: "カゴ", code: "", size: 80, price: "" },
  { id: "ra60", type: "rail", name: "ハンガーパイプ", code: "", size: 60, price: "" },
  { id: "ra80", type: "rail", name: "ハンガーパイプ", code: "", size: 80, price: "" },
];
// 場所の種類と、1列（1マス分の列）ごとに標準で付く棚の数（棚・ブラケットは金額に入れない）
export const PLACE_TYPES: any = { hang: { name: "ハンガー収納", colName: "服掛け", stdShelves: 1 }, shelf: { name: "棚収納", colName: "棚", stdShelves: 4 } };
// 列の種類：hang／shelf／set:<見本ID>（その幅の見本だけ）。無ければ場所の種類。
export function boaxelColKind(kind: any, placeType: string, sets: any[], w: number) {
  const k = String(kind || "");
  if (PLACE_TYPES[k]) return k;
  if (k.startsWith("set:") && (sets || []).some((st: any) => "set:" + st.id === k && st.w === w)) return k;
  return PLACE_TYPES[placeType] ? placeType : "hang";
}
// 標準の数を決める種類（見本はハンガーが入っていれば服掛け、無ければ棚）
export function boaxelStdKind(kind: string, items: string[], byId: any) {
  if (PLACE_TYPES[kind]) return kind;
  return items.some((id) => byId[id] && byId[id].type === "rail") ? "hang" : "shelf";
}
export const MASU_CM = 91; // 1マス＝910mm
export const WALL_CM = 5; // マスから内側の幅を出すときに引く分（1マス91cm→内側86cm＝80cmの1列）
export const UPRIGHT_CM = 2; // 縦レール1本の幅（だいたい）

export function boaxelMax(up: any) { const m = Number(up && up.max); if (m > 0) return Math.min(30, Math.round(m)); const h = Number(up && up.size) || 0; return h >= 200 ? 8 : h >= 120 ? 5 : 3; }

// デモの案件（「デモ様邸（練習用）」など）か
export function isDemoProject(project: any) { return !!(project && (project.demo === true || /デモ/.test(String(project.name || "")))); }

// 部品の一覧（整えたもの）。null＝使えない（設定で止めている・縦レールが無い）
export function boaxelParts(settings: any) {
  const bx = settings && settings.boaxel;
  if (bx && bx.on === false) return null;
  const src = bx && Array.isArray(bx.parts) && bx.parts.length ? bx.parts : BOAXEL_DEFAULTS;
  const parts = src.slice(0, 120).map((x: any) => ({
    id: String((x && x.id) || "").slice(0, 40),
    type: BOAXEL_TYPES.includes(x && x.type) ? x.type : "other",
    name: String((x && x.name) || "").trim().slice(0, 40),
    code: String((x && x.code) || "").trim().slice(0, 40),
    size: Math.max(0, Math.min(400, Number(x && x.size) || 0)),
    price: x && x.price !== "" && x.price != null && isFinite(Number(x.price)) ? Math.round(Number(x.price)) : null,
    max: x && x.type === "upright" ? boaxelMax(x) : undefined,
  })).filter((x: any) => x.id && x.name && (x.size || x.type === "bracket"));
  if (!parts.some((x: any) => x.type === "upright")) return null;
  // 棚板が無い幅は列にできない
  if (!parts.some((x: any) => x.type === "shelf")) return null;
  // 見本（スタッフが「業者・設定」で作った列1つ分の組み合わせ）。お客様は列ごとに見本を選べる。
  const byId: any = {}; parts.forEach((x: any) => { byId[x.id] = x; });
  const sets = (bx && Array.isArray(bx.sets) ? bx.sets : []).slice(0, 40).map((st: any) => {
    const w = Number(st && st.w) || 0;
    return { id: String((st && st.id) || "").slice(0, 40), name: String((st && st.name) || "").trim().slice(0, 30), w,
      items: (Array.isArray(st && st.items) ? st.items : []).map((id: any) => String(id)).filter((id: string) => byId[id] && !["upright", "bracket"].includes(byId[id].type) && byId[id].size === w).slice(0, 30) };
  }).filter((st: any) => st.id && st.name && st.w > 0 && st.items.length);
  return { parts, sets, note: String((bx && bx.note) || "").slice(0, 500) };
}

// おうちノートのお客様に出すか（試しの間はデモの案件だけ）
export function boaxelForNote(settings: any, project: any) {
  const bx = settings && settings.boaxel;
  if ((!bx || bx.demoOnly !== false) && !isDemoProject(project)) return null;
  return boaxelParts(settings);
}
// 公開ページ（OBのお客様など）に出すか（「公開ページを出す」にしたときだけ）
export function boaxelForPublic(settings: any) {
  const bx = settings && settings.boaxel;
  if (!bx || bx.publicOn !== true) return null;
  return boaxelParts(settings);
}

// 内側の幅（cm）に入る列の幅の並び（60／80cmの組み合わせで、いちばん広く使えるもの。同じなら列の少ないほう）
export function colsForInner(inner: number, widths: number[]) {
  const ws = Array.from(new Set(widths.filter((w) => w > 0))).sort((a, b) => b - a);
  let best: number[] = [], bestSum = 0;
  for (let n = 1; n <= 10; n++) {
    // n列の組み合わせ（広い幅から順に）
    const rec = (left: number, from: number, acc: number[]) => {
      if (left === 0) {
        const sum = acc.reduce((a, b) => a + b, 0);
        if (sum + (acc.length + 1) * UPRIGHT_CM <= inner && sum > bestSum) { best = acc.slice(); bestSum = sum; }
        return;
      }
      for (let i = from; i < ws.length; i++) { acc.push(ws[i]); rec(left - 1, i, acc); acc.pop(); }
    };
    rec(n, 0, []);
  }
  return best;
}
export function placeInner(p: any) {
  const cm = Number(p && p.cm) || 0;
  if (cm > 0) return Math.min(800, cm);
  const masu = Number(p && p.masu) || 0;
  return masu > 0 ? Math.max(0, masu * MASU_CM - WALL_CM) : 0;
}

// 段ごとにブラケットを数える（items[r] が棚・カゴなら、その段で横につながった数＋1）
export function bracketCount(cols: string[][], byId: any) {
  let n = 0;
  const rows = Math.max(0, ...cols.map((c) => c.length));
  for (let r = 0; r < rows; r++) {
    let run = 0;
    cols.forEach((c) => {
      const x = byId[c[r]];
      if (x && BOAXEL_BRACKETED.includes(x.type)) run++;
      else { if (run) n += run + 1; run = 0; }
    });
    if (run) n += run + 1;
  }
  return n;
}

// お客様のプラン（場所の並び）から、場所ごとの列・部品と、全体の部品・金額を数える。
// plan.places=[{name,type,masu|cm,height(縦レールの部品ID),cols:[{extras:[部品ID…上から順]}]}]
// 列の数と幅は幅（マス／cm）から決め直し、標準の棚（ハンガー収納1枚・棚収納4枚）は先頭に自動で入れる（お客様が送ってきた分は「足した分」）。
export function boaxelPlan(cat: any, plan: any) {
  const byId: any = {}; cat.parts.forEach((x: any) => { byId[x.id] = x; });
  const ups = cat.parts.filter((x: any) => x.type === "upright").sort((a: any, b: any) => b.size - a.size);
  const shelfOf = (w: number) => cat.parts.find((x: any) => x.type === "shelf" && x.size === w);
  const widths = cat.parts.filter((x: any) => x.type === "shelf").map((x: any) => x.size);
  const br = cat.parts.find((x: any) => x.type === "bracket");
  const count: any = {}, std: any = {};
  const add = (o: any, id: string, n: number) => { if (id && n) o[id] = (o[id] || 0) + n; };
  const places: any[] = [];
  const src = Array.isArray(plan && plan.places) ? plan.places.slice(0, 12) : [];
  for (const p of src) {
    const type = PLACE_TYPES[p && p.type] ? p.type : "hang";
    const up = ups[0]; // 高さは200cm（いちばん長い縦レール）だけ
    const max = boaxelMax(up);
    const inner = placeInner(p);
    const masuN = Number(p && p.masu) || 0;
    // マスが整数なら1マス＝80cmの1列ずつ（画面の colsFor と同じ）
    const ws = !(Number(p && p.cm) > 0) && masuN > 0 && masuN === Math.floor(masuN) && widths.includes(80) ? Array.from({ length: Math.min(10, masuN) }, () => 80) : colsForInner(inner, widths);
    if (!ws.length) return { error: "too_narrow", place: String(p && p.name || "") };
    const srcCols = Array.isArray(p && p.cols) ? p.cols : [];
    // 列ごとに種類（服掛け／棚／見本）と部品の並び（上から）。標準＝その列の種類の棚の数まで（金額に入れない）。
    const cols = ws.map((w, i) => {
      const sc = srcCols[i] || {};
      const kind = boaxelColKind(sc.kind, type, cat.sets, w);
      const okId = (id: string) => byId[id] && !["upright", "bracket"].includes(byId[id].type) && byId[id].size === w;
      let items: string[];
      if (Array.isArray(sc.items)) items = sc.items.slice(0, 30).map((id: any) => String(id)).filter(okId);
      else {
        // 以前の形（標準の棚＋足した分 extras）
        const sh = shelfOf(w);
        items = (sh ? Array.from({ length: Math.min(max, PLACE_TYPES[type].stdShelves) }, () => sh.id) : [])
          .concat((Array.isArray(sc.extras) ? sc.extras : []).slice(0, 30).map((id: any) => String(id)).filter(okId));
      }
      const stdN = Math.min(max, PLACE_TYPES[boaxelStdKind(kind, items, byId)].stdShelves);
      let left = stdN, railLeft = boaxelStdKind(kind, items, byId) === "hang" ? 1 : 0; // 服掛けはハンガーパイプ1本も標準
      const stdArr = items.map((id) => {
        if (left > 0 && byId[id].type === "shelf") { left--; return id; }
        if (railLeft > 0 && byId[id].type === "rail") { railLeft--; return id; }
        return "";
      });
      const kindName = kind.startsWith("set:") ? ((cat.sets.find((st: any) => "set:" + st.id === kind) || {}).name || "見本") : PLACE_TYPES[kind].colName;
      return { w, kind, kindName, items, stdArr, std: stdArr.filter(Boolean) };
    });
    if (cols.some((c) => c.items.length > max)) return { error: "too_many_items", place: String(p && p.name || "") };
    // 縦レールは列の数＋1本（標準＝金額に入れない。棚を付けるのに必ず要るため）
    add(count, up.id, cols.length + 1);
    add(std, up.id, cols.length + 1);
    cols.forEach((c) => c.items.forEach((id: string) => add(count, id, 1)));
    cols.forEach((c) => c.std.forEach((id: string) => add(std, id, 1)));
    if (br) {
      add(count, br.id, bracketCount(cols.map((c) => c.items), byId));
      add(std, br.id, bracketCount(cols.map((c) => c.stdArr), byId));
    }
    places.push({
      name: String(p && p.name || "").trim().slice(0, 40) || "収納",
      type, typeName: PLACE_TYPES[type].name,
      masu: Number(p && p.masu) || 0, cm: Number(p && p.cm) || 0, inner: Math.round(inner),
      height: up.size, upright: up.id, max,
      cols: cols.map((c) => ({ w: c.w, kind: c.kind, kindName: c.kindName, std: c.std.length, items: c.items })),
    });
  }
  if (!places.length) return null;
  const lines = Object.keys(count).map((id) => {
    const x = byId[id], qty = count[id], s = Math.min(qty, std[id] || 0), pay = qty - s;
    return { id, type: x.type, name: x.name, code: x.code, size: x.size, qty, std: s, price: x.price, sub: x.price != null ? x.price * pay : (pay ? null : 0) };
  });
  const allPriced = lines.every((l: any) => l.sub != null);
  const total = lines.reduce((a: number, l: any) => a + (l.sub || 0), 0);
  return { places, lines, total: allPriced ? total : null, partial: !allPriced && lines.some((l: any) => l.sub) };
}
