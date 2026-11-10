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
export const PLACE_TYPES: any = { hang: { name: "ハンガー収納", stdShelves: 1 }, shelf: { name: "棚収納", stdShelves: 4 } };
export const MASU_CM = 91; // 1マス＝910mm
export const WALL_CM = 10.5; // マスから内側の幅を出すときに引く壁の厚み（だいたい）
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
  return { parts, note: String((bx && bx.note) || "").slice(0, 500) };
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
    const up = byId[String(p && p.height || "")] && byId[String(p.height)].type === "upright" ? byId[String(p.height)] : ups[0];
    const max = boaxelMax(up);
    const inner = placeInner(p);
    const ws = colsForInner(inner, widths);
    if (!ws.length) return { error: "too_narrow", place: String(p && p.name || "") };
    const stdN = Math.min(max, PLACE_TYPES[type].stdShelves);
    const srcCols = Array.isArray(p && p.cols) ? p.cols : [];
    const cols = ws.map((w, i) => {
      const sh = shelfOf(w);
      const stdItems = sh ? Array.from({ length: stdN }, () => sh.id) : [];
      const extras = (Array.isArray(srcCols[i] && srcCols[i].extras) ? srcCols[i].extras : []).slice(0, 30).map((id: any) => String(id))
        .filter((id: string) => byId[id] && !["upright", "bracket"].includes(byId[id].type) && byId[id].size === w);
      return { w, std: stdItems, extras, items: stdItems.concat(extras) };
    });
    if (cols.some((c) => c.items.length > max)) return { error: "too_many_items", place: String(p && p.name || "") };
    // 縦レールは列の数＋1本（標準＝金額に入れない。棚を付けるのに必ず要るため）
    add(count, up.id, cols.length + 1);
    add(std, up.id, cols.length + 1);
    cols.forEach((c) => c.items.forEach((id: string) => add(count, id, 1)));
    cols.forEach((c) => c.std.forEach((id: string) => add(std, id, 1)));
    if (br) {
      add(count, br.id, bracketCount(cols.map((c) => c.items), byId));
      add(std, br.id, bracketCount(cols.map((c) => c.std), byId));
    }
    places.push({
      name: String(p && p.name || "").trim().slice(0, 40) || "収納",
      type, typeName: PLACE_TYPES[type].name,
      masu: Number(p && p.masu) || 0, cm: Number(p && p.cm) || 0, inner: Math.round(inner),
      height: up.size, upright: up.id, max,
      cols: cols.map((c) => ({ w: c.w, std: c.std.length, items: c.items })),
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
