// Supabase Edge Function の入口。合言葉を確かめ、保存先(Postgres・Storage)と Gemini を core につなぐ。
import { createClient } from 'npm:@supabase/supabase-js@2';
import { AppError, handle, passOk } from './core.ts';
import type { Item, NewRecipe, Recipe, Store } from './core.ts';
import { makeGemini, prompts } from './gemini.ts';

const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type, x-passcode',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Max-Age': '86400',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'content-type': 'application/json; charset=utf-8' } });

function must<T>(res: { data: T; error: { message: string } | null }): T {
  if (res.error) {
    console.error('db error', res.error.message);
    throw new AppError('db', '保存先とのやりとりに失敗しました。もう一度お試しください。', 500);
  }
  return res.data;
}

const toItem = (r: any): Item => ({ id: r.id, name: r.name, category: r.category, addedOn: r.added_on, expiresOn: r.expires_on });
const toRecipe = (r: any): Recipe => ({
  id: r.id,
  scene: r.scene,
  title: r.title,
  lead: r.lead,
  minutes: r.minutes,
  servings: r.servings,
  ingredients: r.ingredients,
  steps: r.steps,
  tip: r.tip,
  imageUrl: r.image_url,
  cookedAt: r.cooked_at,
  createdAt: r.created_at,
});

const store: Store = {
  async listItems() {
    return must(await sb.from('items').select('*').is('gone_at', null).order('expires_on').order('name')).map(toItem);
  },
  async addItems(rows) {
    must(await sb.from('items').insert(rows.map((r) => ({ ...(r.id ? { id: r.id } : {}), name: r.name, category: r.category, added_on: r.addedOn, expires_on: r.expiresOn }))));
  },
  async updateItem(id, patch) {
    const row: Record<string, unknown> = {};
    if (patch.name) row.name = patch.name;
    if (patch.category) row.category = patch.category;
    if (patch.expiresOn) row.expires_on = patch.expiresOn;
    if (Object.keys(row).length) must(await sb.from('items').update(row).eq('id', id));
  },
  async removeItems(ids) {
    if (ids.length) must(await sb.from('items').update({ gone_at: new Date().toISOString() }).in('id', ids));
  },
  async getKv<T>(key: string) {
    const row = must(await sb.from('kv').select('value').eq('key', key).maybeSingle());
    return row ? ((row as any).value as T) : null;
  },
  async setKv(key, value) {
    must(await sb.from('kv').upsert({ key, value, updated_at: new Date().toISOString() }));
  },
  async saveRecipes(rows: NewRecipe[]) {
    return must(await sb.from('recipes').insert(rows).select('*')).map(toRecipe);
  },
  async getRecipe(id) {
    if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
    const row = must(await sb.from('recipes').select('*').eq('id', id).maybeSingle());
    return row ? toRecipe(row) : null;
  },
  async updateRecipe(id, patch) {
    const row: Record<string, unknown> = {};
    if (patch.imageUrl) row.image_url = patch.imageUrl;
    if (patch.cookedAt) row.cooked_at = patch.cookedAt;
    if (Object.keys(row).length) must(await sb.from('recipes').update(row).eq('id', id));
  },
  async recentRecipes(limit) {
    return must(await sb.from('recipes').select('*').order('created_at', { ascending: false }).limit(limit)).map(toRecipe);
  },
  async uploadImage(path, bytes, mime) {
    const up = await sb.storage.from('dishes').upload(path, bytes, { contentType: mime, upsert: true, cacheControl: '31536000' });
    if (up.error) {
      console.error('storage error', up.error.message);
      throw new AppError('storage', '写真を保存できませんでした。', 500);
    }
    return sb.storage.from('dishes').getPublicUrl(path).data.publicUrl;
  },
};

// 秘密の値は少しの間だけ覚えておく(毎回データベースを読まない)
let cache: { at: number; passHash: string | null; geminiKey: string | null } | null = null;
async function secrets() {
  if (cache && Date.now() - cache.at < 60_000) return cache;
  const [passHash, geminiKey] = await Promise.all([store.getKv<string>('secret:passhash'), store.getKv<string>('secret:gemini')]);
  cache = { at: Date.now(), passHash, geminiKey: Deno.env.get('GEMINI_API_KEY') ?? geminiKey };
  return cache;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (req.method !== 'POST') return json({ error: { code: 'method', message: 'POST だけ受け付けます。' } }, 405);
  try {
    const sec = await secrets();
    if (!(await passOk(req.headers.get('x-passcode'), sec.passHash))) {
      await new Promise((r) => setTimeout(r, 400)); // 総当たりを遅くする
      return json({ error: { code: 'passcode', message: '合言葉が違います。' } }, 401);
    }
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const action = typeof body.action === 'string' ? body.action : '';

    if (action === 'setup') {
      // Gemini のキーを登録する(手元から1回だけ送る)
      const key = typeof body.geminiKey === 'string' ? body.geminiKey.trim() : '';
      if (key.length < 20) return json({ error: { code: 'bad', message: 'キーが正しくありません。' } }, 400);
      await store.setKv('secret:gemini', key);
      cache = null;
      return json({ ok: true });
    }
    if (action === 'ping') return json({ ok: true, ai: !!sec.geminiKey });

    if (!sec.geminiKey) return json({ error: { code: 'setup', message: 'AI のキーがまだ登録されていません。' } }, 503);
    const ai = makeGemini({ key: sec.geminiKey, textModel: Deno.env.get('TEXT_MODEL'), imageModel: Deno.env.get('IMAGE_MODEL') });
    return json(await handle(action, body, { store, ai, prompts }));
  } catch (e) {
    if (e instanceof AppError) return json({ error: { code: e.code, message: e.message } }, e.status);
    console.error('unexpected', e);
    return json({ error: { code: 'server', message: 'うまくいきませんでした。もう一度お試しください。' } }, 500);
  }
});
