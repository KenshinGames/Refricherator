// 処理の本体。Supabase にも Gemini にも直接は触らず、渡された store と ai だけを使う。
// そのため手元(Node)のテストと、本番(Supabase Edge Function / Deno)で同じものが動く。

export type Scene = 'tired' | 'holiday' | 'bento';
export const SCENES: Scene[] = ['tired', 'holiday', 'bento'];

export const CATEGORIES = ['野菜', '果物', '肉', '魚介', '卵・乳製品', '大豆製品', '主食', '加工品', 'その他'] as const;

/** いつも家にあるものとして扱う調味料など(食材として登録しない) */
export const PANTRY = [
  '塩', 'こしょう', '砂糖', '醤油', 'みりん', '酒', '酢', '味噌', 'サラダ油', 'ごま油', 'オリーブオイル',
  '小麦粉', '片栗粉', '米', 'だしの素', '鶏がらスープの素', 'コンソメ', 'マヨネーズ', 'ケチャップ', 'ソース',
  'にんにくチューブ', 'しょうがチューブ', '水',
];

export interface Item {
  id: string;
  name: string;
  category: string;
  addedOn: string; // YYYY-MM-DD(日本時間)
  expiresOn: string;
}
export interface NewItem {
  id?: string; // 画面側で決めた ID(足した直後から同じ ID で扱えるようにする)
  name: string;
  category: string;
  days: number;
}
export interface Ingredient {
  name: string;
  amount: string;
  source: 'fridge' | 'pantry' | 'buy';
  itemId?: string;
}
export interface Recipe {
  id: string;
  scene: Scene;
  title: string;
  lead: string;
  minutes: number;
  servings: number;
  ingredients: Ingredient[];
  steps: string[];
  tip: string;
  imageUrl: string | null;
  cookedAt: string | null;
  createdAt: string;
}
export type NewRecipe = Omit<Recipe, 'id' | 'imageUrl' | 'cookedAt' | 'createdAt'>;
export interface Settings {
  servings: number;
  dislikes: string;
}
export interface Staple {
  name: string;
  category: string;
  days: number;
  count: number;
}
export interface Usage {
  images: number;
  texts: number;
}
export interface ShoppingIdea {
  buy: string;
  dish: string;
  uses: string[];
  minutes: number;
}

export interface Store {
  listItems(): Promise<Item[]>;
  addItems(rows: (Omit<Item, 'id'> & { id?: string })[]): Promise<void>;
  updateItem(id: string, patch: Partial<Pick<Item, 'name' | 'category' | 'expiresOn'>>): Promise<void>;
  removeItems(ids: string[]): Promise<void>;
  getKv<T>(key: string): Promise<T | null>;
  setKv(key: string, value: unknown): Promise<void>;
  saveRecipes(rows: NewRecipe[]): Promise<Recipe[]>;
  getRecipe(id: string): Promise<Recipe | null>;
  updateRecipe(id: string, patch: { imageUrl?: string; cookedAt?: string }): Promise<void>;
  recentRecipes(limit: number): Promise<Recipe[]>;
  uploadImage(path: string, bytes: Uint8Array, mime: string): Promise<string>;
}

export type Part = { text: string } | { inlineData: { mimeType: string; data: string } };
export interface AI {
  json(parts: Part[], schema: unknown): Promise<unknown>;
  image(prompt: string): Promise<{ bytes: Uint8Array; mime: string }>;
}

export interface Limits {
  images: number; // 1か月に作る写真の上限
  texts: number; // 1か月の文章の上限
}
export const DEFAULT_LIMITS: Limits = { images: 180, texts: 1500 };
export const DEFAULT_SETTINGS: Settings = { servings: 1, dislikes: '' };

export interface Deps {
  store: Store;
  ai: AI;
  now?: () => Date;
  limits?: Limits;
  prompts: Prompts;
}
/** 指示文と応答の形(gemini.ts にある。テストでは差し替えられる) */
export interface Prompts {
  parseText(text: string): { parts: Part[]; schema: unknown };
  parseImage(image: { data: string; mime: string }, kind: 'receipt' | 'photo'): { parts: Part[]; schema: unknown };
  suggest(input: SuggestInput): { parts: Part[]; schema: unknown };
  shopping(input: { items: (Item & { daysLeft: number })[]; settings: Settings }): { parts: Part[]; schema: unknown };
  image(recipe: Recipe): string;
}
export interface SuggestInput {
  scene: Scene;
  items: (Item & { daysLeft: number })[];
  settings: Settings;
  avoid: string[];
  dish?: string; // 指定の1品だけ作るとき
  buy?: string; // そのとき買い足す前提のもの
}

export class AppError extends Error {
  code: string;
  status: number;
  constructor(code: string, message: string, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

// ───────── 日付 ─────────

/** 日本時間の今日(YYYY-MM-DD) */
export function todayJst(now: Date = new Date()): string {
  return new Date(now.getTime() + 9 * 3600_000).toISOString().slice(0, 10);
}
export function addDays(date: string, days: number): string {
  const d = new Date(date + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(to + 'T00:00:00Z') - Date.parse(from + 'T00:00:00Z')) / 86400_000);
}

// ───────── AI の応答を安全な形に直す ─────────

const str = (v: unknown, max: number): string => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const int = (v: unknown, min: number, max: number, fallback: number): number => {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fallback;
};
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {});

/** 比べるための名前(空白・かっこ書きを取る) */
export function normName(name: string): string {
  return name.replace(/[\s　]/g, '').replace(/[（(].*?[）)]/g, '').toLowerCase();
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function cleanItems(raw: unknown): NewItem[] {
  const seen = new Set<string>();
  const out: NewItem[] = [];
  for (const r of list(obj(raw).items ?? raw)) {
    const o = obj(r);
    const name = str(o.name, 30);
    const key = normName(name);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const category = (CATEGORIES as readonly string[]).includes(str(o.category, 10)) ? str(o.category, 10) : 'その他';
    const id = typeof o.id === 'string' && UUID.test(o.id) ? o.id : undefined;
    out.push({ ...(id ? { id } : {}), name, category, days: int(o.days, 1, 365, 5) });
    if (out.length >= 40) break;
  }
  return out;
}

function matchItem(name: string, items: Item[]): Item | undefined {
  const key = normName(name);
  if (!key) return undefined;
  return (
    items.find((i) => normName(i.name) === key) ??
    items.find((i) => normName(i.name).includes(key) || key.includes(normName(i.name)))
  );
}
function isPantry(name: string): boolean {
  const key = normName(name);
  return PANTRY.some((p) => key === normName(p) || key.includes(normName(p)));
}

export function cleanDishes(raw: unknown, items: Item[], scene: Scene, servings: number, max: number): NewRecipe[] {
  const out: NewRecipe[] = [];
  for (const r of list(obj(raw).dishes)) {
    const o = obj(r);
    const title = str(o.title, 40);
    const steps = list(o.steps).map((s) => str(s, 200)).filter(Boolean).slice(0, 12);
    const ingredients: Ingredient[] = [];
    for (const g of list(o.ingredients)) {
      const go = obj(g);
      const name = str(go.name, 30);
      if (!name) continue;
      const amount = str(go.amount, 20);
      // AI が「冷蔵庫にある」と言っても、実際の一覧で確かめる(ないものを「ある」と見せない)
      const hit = matchItem(name, items);
      if (hit) ingredients.push({ name, amount, source: 'fridge', itemId: hit.id });
      else if (go.source === 'pantry' || isPantry(name)) ingredients.push({ name, amount, source: 'pantry' });
      else ingredients.push({ name, amount, source: 'buy' });
      if (ingredients.length >= 20) break;
    }
    if (!title || !steps.length || !ingredients.length) continue;
    out.push({
      scene,
      title,
      lead: str(o.lead, 60),
      minutes: int(o.minutes, 1, 240, 15),
      servings,
      ingredients,
      steps,
      tip: str(o.tip, 120),
    });
    if (out.length >= max) break;
  }
  return out;
}

export function cleanIdeas(raw: unknown): ShoppingIdea[] {
  const out: ShoppingIdea[] = [];
  for (const r of list(obj(raw).ideas)) {
    const o = obj(r);
    const buy = str(o.buy, 20);
    const dish = str(o.dish, 40);
    if (!buy || !dish) continue;
    out.push({ buy, dish, uses: list(o.uses).map((u) => str(u, 20)).filter(Boolean).slice(0, 5), minutes: int(o.minutes, 1, 240, 20) });
    if (out.length >= 5) break;
  }
  return out;
}

// ───────── 合言葉 ─────────

export async function sha256(text: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
export async function passOk(given: string | null, storedHash: string | null): Promise<boolean> {
  if (!given || !storedHash || given.length > 200) return false;
  const h = await sha256(given);
  let diff = h.length ^ storedHash.length;
  for (let i = 0; i < h.length; i++) diff |= h.charCodeAt(i) ^ (storedHash.charCodeAt(i) || 0);
  return diff === 0;
}

// ───────── 本体 ─────────

async function usage(d: Deps): Promise<{ key: string; value: Usage }> {
  const key = 'usage:' + todayJst(d.now?.()).slice(0, 7);
  return { key, value: (await d.store.getKv<Usage>(key)) ?? { images: 0, texts: 0 } };
}
async function countText(d: Deps): Promise<void> {
  const u = await usage(d);
  if (u.value.texts >= (d.limits ?? DEFAULT_LIMITS).texts) {
    throw new AppError('limit', '今月の利用上限に達しました。来月になるとまた使えます。', 429);
  }
  await d.store.setKv(u.key, { ...u.value, texts: u.value.texts + 1 });
}
async function withDays(d: Deps): Promise<(Item & { daysLeft: number })[]> {
  const today = todayJst(d.now?.());
  return (await d.store.listItems())
    .map((i) => ({ ...i, daysLeft: daysBetween(today, i.expiresOn) }))
    .sort((a, b) => a.daysLeft - b.daysLeft || a.name.localeCompare(b.name, 'ja'));
}
async function staples(d: Deps): Promise<Staple[]> {
  const all = (await d.store.getKv<Record<string, Staple>>('staples')) ?? {};
  return Object.values(all).sort((a, b) => b.count - a.count).slice(0, 12);
}
async function settings(d: Deps): Promise<Settings> {
  return { ...DEFAULT_SETTINGS, ...((await d.store.getKv<Settings>('settings')) ?? {}) };
}

export async function handle(action: string, body: Record<string, unknown>, d: Deps): Promise<unknown> {
  const { store, ai, prompts } = d;
  const limits = d.limits ?? DEFAULT_LIMITS;

  switch (action) {
    case 'sync': {
      const [items, set, stp, use] = await Promise.all([store.listItems(), settings(d), staples(d), usage(d)]);
      return { items, settings: set, staples: stp, usage: use.value, limits, today: todayJst(d.now?.()) };
    }

    case 'parse': {
      const image = obj(body.image);
      const text = str(body.text, 500);
      let req: { parts: Part[]; schema: unknown };
      if (typeof image.data === 'string' && image.data) {
        if (image.data.length > 6_000_000) throw new AppError('too_big', '写真が大きすぎます。もう一度撮ってみてください。');
        const mime = str(image.mime, 30) || 'image/jpeg';
        req = prompts.parseImage({ data: image.data, mime }, body.kind === 'receipt' ? 'receipt' : 'photo');
      } else if (text) {
        req = prompts.parseText(text);
      } else {
        throw new AppError('empty', '読み取るものがありません。');
      }
      await countText(d);
      return { items: cleanItems(await ai.json(req.parts, req.schema)) };
    }

    case 'add': {
      const rows = cleanItems(body.items);
      if (!rows.length) throw new AppError('empty', '足す食材がありません。');
      const today = todayJst(d.now?.());
      // 同じ ID がもうあるときは足さない(通信のやり直しで二重に入らないようにする)
      const have = new Set((await store.listItems()).map((i) => i.id));
      const fresh = rows.filter((r) => !r.id || !have.has(r.id));
      if (fresh.length) {
        await store.addItems(fresh.map((r) => ({ ...(r.id ? { id: r.id } : {}), name: r.name, category: r.category, addedOn: today, expiresOn: addDays(today, r.days) })));
      }
      const all = (await store.getKv<Record<string, Staple>>('staples')) ?? {};
      for (const r of fresh) {
        const key = normName(r.name);
        all[key] = { name: r.name, category: r.category, days: r.days, count: (all[key]?.count ?? 0) + 1 };
      }
      await store.setKv('staples', all);
      return { items: await store.listItems(), staples: await staples(d) };
    }

    case 'update': {
      const id = str(body.id, 60);
      if (!id) throw new AppError('bad', '食材が見つかりません。');
      const patch: Partial<Pick<Item, 'name' | 'expiresOn'>> = {};
      if (body.days !== undefined) patch.expiresOn = addDays(todayJst(d.now?.()), int(body.days, 0, 365, 3));
      if (str(body.name, 30)) patch.name = str(body.name, 30);
      await store.updateItem(id, patch);
      return { items: await store.listItems() };
    }

    case 'remove': {
      const ids = list(body.ids).map((v) => str(v, 60)).filter(Boolean);
      await store.removeItems(ids);
      return { items: await store.listItems() };
    }

    case 'suggest': {
      const scene = (SCENES as string[]).includes(str(body.scene, 10)) ? (body.scene as Scene) : 'tired';
      const dish = str(body.dish, 40) || undefined;
      const items = await withDays(d);
      if (!items.length && !dish) throw new AppError('no_items', 'まず冷蔵庫に食材を入れてください。');
      const set = await settings(d);
      const recent = (await store.recentRecipes(12)).map((r) => r.title);
      const avoid = [...new Set([...list(body.avoid).map((v) => str(v, 40)).filter(Boolean), ...recent])].slice(0, 20);
      await countText(d);
      const req = prompts.suggest({ scene, items, settings: set, avoid: dish ? [] : avoid, dish, buy: str(body.buy, 20) || undefined });
      const dishes = cleanDishes(await ai.json(req.parts, req.schema), items, scene, set.servings, dish ? 1 : 3);
      if (!dishes.length) throw new AppError('ai_empty', 'うまく提案を作れませんでした。もう一度お試しください。', 502);
      return { recipes: await store.saveRecipes(dishes) };
    }

    case 'image': {
      const recipe = await store.getRecipe(str(body.id, 60));
      if (!recipe) throw new AppError('bad', 'レシピが見つかりません。', 404);
      if (recipe.imageUrl) return { url: recipe.imageUrl };
      const u = await usage(d);
      if (u.value.images >= limits.images) return { capped: true };
      // 先に数える(同時に3枚頼まれても上限を越えにくくする)
      await store.setKv(u.key, { ...u.value, images: u.value.images + 1 });
      const img = await ai.image(prompts.image(recipe));
      const ext = img.mime.includes('png') ? 'png' : 'jpg';
      const url = await store.uploadImage(`${recipe.id}.${ext}`, img.bytes, img.mime);
      await store.updateRecipe(recipe.id, { imageUrl: url });
      return { url };
    }

    case 'cooked': {
      const id = str(body.id, 60);
      const ids = list(body.usedUp).map((v) => str(v, 60)).filter(Boolean);
      if (id) await store.updateRecipe(id, { cookedAt: (d.now?.() ?? new Date()).toISOString() });
      await store.removeItems(ids);
      return { items: await store.listItems() };
    }

    case 'shopping': {
      const items = await withDays(d);
      if (!items.length) return { ideas: [] };
      const key = todayJst(d.now?.()) + ':' + items.map((i) => i.id).sort().join(',');
      const cached = await store.getKv<{ key: string; ideas: ShoppingIdea[] }>('shopping');
      if (cached?.key === key && !body.fresh) return { ideas: cached.ideas };
      await countText(d);
      const req = prompts.shopping({ items, settings: await settings(d) });
      const ideas = cleanIdeas(await ai.json(req.parts, req.schema));
      await store.setKv('shopping', { key, ideas });
      return { ideas };
    }

    case 'settings': {
      const s = obj(body.settings);
      const next: Settings = { servings: int(s.servings, 1, 6, 1), dislikes: str(s.dislikes, 200) };
      await store.setKv('settings', next);
      return { settings: next };
    }

    default:
      throw new AppError('unknown', '対応していない操作です。', 404);
  }
}
