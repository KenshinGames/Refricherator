import { beforeEach, describe, expect, it } from 'vitest';
import {
  addDays,
  AppError,
  cleanDishes,
  cleanItems,
  daysBetween,
  handle,
  normName,
  passOk,
  sha256,
  todayJst,
} from '../supabase/functions/api/core.ts';
import type { Deps, Item, Recipe } from '../supabase/functions/api/core.ts';
import { prompts } from '../supabase/functions/api/gemini.ts';
import { makeFakeAI, makeMemoryStore } from '../tools/memory.ts';

const NOW = new Date('2026-11-14T03:00:00Z'); // 日本時間 11/14 12:00

function setup(limits?: Deps['limits']) {
  const store = makeMemoryStore();
  const ai = makeFakeAI();
  const deps: Deps = { store, ai, prompts, now: () => NOW, limits };
  const call = (action: string, body: Record<string, unknown> = {}) => handle(action, body, deps) as Promise<any>;
  return { store, ai, deps, call };
}

describe('日付', () => {
  it('日本時間の今日を返す(UTC では前日の夜でも)', () => {
    expect(todayJst(new Date('2026-11-13T15:30:00Z'))).toBe('2026-11-14');
    expect(todayJst(new Date('2026-11-13T14:59:00Z'))).toBe('2026-11-13');
  });
  it('日数を足す・差を出す(月をまたぐ)', () => {
    expect(addDays('2026-11-29', 3)).toBe('2026-12-02');
    expect(daysBetween('2026-11-14', '2026-11-16')).toBe(2);
    expect(daysBetween('2026-11-14', '2026-11-13')).toBe(-1);
  });
});

describe('AI の応答を直す', () => {
  it('食材:名前なし・重複を落とし、分類と日数をはみ出さない値にする', () => {
    const items = cleanItems({
      items: [
        { name: ' 豚こま肉 ', category: '肉', days: 3 },
        { name: '豚こま肉', category: '肉', days: 3 },
        { name: '', category: '肉', days: 3 },
        { name: 'なぞの物', category: '宇宙', days: 9999 },
        { name: '卵', category: '卵・乳製品', days: '14' },
        { name: 'もやし', category: '野菜', days: -5 },
        { name: 'ねぎ', category: '野菜' },
      ],
    });
    expect(items).toEqual([
      { name: '豚こま肉', category: '肉', days: 3 },
      { name: 'なぞの物', category: 'その他', days: 365 },
      { name: '卵', category: '卵・乳製品', days: 14 },
      { name: 'もやし', category: '野菜', days: 1 },
      { name: 'ねぎ', category: '野菜', days: 5 },
    ]);
  });
  it('食材:おかしな形でも落ちない', () => {
    expect(cleanItems(null)).toEqual([]);
    expect(cleanItems('abc')).toEqual([]);
    expect(cleanItems({ items: 'x' })).toEqual([]);
    expect(cleanItems([{ name: '卵', category: '卵・乳製品', days: 14 }])).toHaveLength(1);
  });
  it('名前を比べるときは空白とかっこ書きを無視する', () => {
    expect(normName('豚こま 肉(国産)')).toBe('豚こま肉');
  });
  it('料理:冷蔵庫にないものを「ある」と言われても、買い足しとして扱う', () => {
    const items: Item[] = [{ id: 'a', name: '豚こま肉', category: '肉', addedOn: '2026-11-14', expiresOn: '2026-11-17' }];
    const [dish] = cleanDishes(
      {
        dishes: [
          {
            title: '炒めもの',
            lead: '',
            minutes: 10,
            ingredients: [
              { name: '豚こま', amount: '100g', source: 'fridge' },
              { name: '小松菜', amount: '1束', source: 'fridge' },
              { name: '醤油', amount: '大さじ1', source: 'fridge' },
              { name: '長ねぎ', amount: '1本', source: 'buy' },
            ],
            steps: ['炒める'],
            tip: '',
          },
          { title: '手順なし', minutes: 5, ingredients: [{ name: '卵', amount: '1個', source: 'fridge' }], steps: [] },
        ],
      },
      items,
      'tired',
      2,
      3,
    );
    expect(dish.ingredients).toEqual([
      { name: '豚こま', amount: '100g', source: 'fridge', itemId: 'a' },
      { name: '小松菜', amount: '1束', source: 'buy' },
      { name: '醤油', amount: '大さじ1', source: 'pantry' },
      { name: '長ねぎ', amount: '1本', source: 'buy' },
    ]);
    expect(dish.servings).toBe(2);
  });
});

describe('合言葉', () => {
  it('合っているときだけ通す', async () => {
    const hash = await sha256('hiraku-goma');
    expect(await passOk('hiraku-goma', hash)).toBe(true);
    expect(await passOk('hiraku-gomb', hash)).toBe(false);
    expect(await passOk('', hash)).toBe(false);
    expect(await passOk(null, hash)).toBe(false);
    expect(await passOk('hiraku-goma', null)).toBe(false);
  });
});

describe('食材を足す・直す・なくす', () => {
  let t: ReturnType<typeof setup>;
  beforeEach(() => {
    t = setup();
  });

  it('足すと期限の近い順に並び、期限は今日からの日数で決まる', async () => {
    const res = await t.call('add', {
      items: [
        { name: '卵', category: '卵・乳製品', days: 14 },
        { name: '豚こま肉', category: '肉', days: 3 },
      ],
    });
    expect(res.items.map((i: Item) => [i.name, i.expiresOn])).toEqual([
      ['豚こま肉', '2026-11-17'],
      ['卵', '2026-11-28'],
    ]);
  });
  it('足したものは「いつもの」に数えられ、回数の多い順に返る', async () => {
    await t.call('add', { items: [{ name: '卵', category: '卵・乳製品', days: 14 }] });
    await t.call('add', { items: [{ name: '卵', category: '卵・乳製品', days: 14 }, { name: '牛乳', category: '卵・乳製品', days: 7 }] });
    const sync = await t.call('sync');
    expect(sync.staples.map((s: any) => [s.name, s.count])).toEqual([
      ['卵', 2],
      ['牛乳', 1],
    ]);
    expect(sync.today).toBe('2026-11-14');
    expect(sync.settings).toEqual({ servings: 1, dislikes: '' });
  });
  it('画面側で決めた ID をそのまま使い、同じ ID を2回送っても二重に入らない', async () => {
    const id = '3f0c1b1e-8a53-4d0e-9b57-0a4f6f0f9a11';
    await t.call('add', { items: [{ id, name: '卵', category: '卵・乳製品', days: 14 }] });
    const res = await t.call('add', { items: [{ id, name: '卵', category: '卵・乳製品', days: 14 }] });
    expect(res.items).toHaveLength(1);
    expect(res.items[0].id).toBe(id);
    expect(res.staples[0].count).toBe(1);
    const bad = await t.call('add', { items: [{ id: 'drop table', name: '牛乳', category: '卵・乳製品', days: 7 }] });
    expect(bad.items.find((i: Item) => i.name === '牛乳')!.id).not.toBe('drop table');
  });
  it('空のまま足そうとすると断る', async () => {
    await expect(t.call('add', { items: [] })).rejects.toBeInstanceOf(AppError);
  });
  it('期限を直せる・なくせる', async () => {
    const { items } = await t.call('add', { items: [{ name: '牛乳', category: '卵・乳製品', days: 7 }] });
    const upd = await t.call('update', { id: items[0].id, days: 1 });
    expect(upd.items[0].expiresOn).toBe('2026-11-15');
    const rem = await t.call('remove', { ids: [items[0].id] });
    expect(rem.items).toEqual([]);
  });
});

describe('読み取り', () => {
  it('文章から食材を読み取る(保存はしない)', async () => {
    const t = setup();
    const res = await t.call('parse', { text: '卵と牛乳と、豚こま買った' });
    expect(res.items.map((i: any) => i.name).sort()).toEqual(['卵', '牛乳', '豚こま肉'].sort());
    expect((await t.call('sync')).items).toEqual([]);
    expect(t.ai.calls[0].kind).toBe('parseText');
  });
  it('写真から読み取る。レシートと写真で指示が変わる', async () => {
    const t = setup();
    await t.call('parse', { image: { data: 'AAAA', mime: 'image/jpeg' }, kind: 'receipt' });
    await t.call('parse', { image: { data: 'AAAA', mime: 'image/jpeg' }, kind: 'photo' });
    expect(t.ai.calls.map((c) => c.kind)).toEqual(['parseImage', 'parseImage']);
    expect(t.ai.calls[0].text).toContain('レシート');
    expect(t.ai.calls[1].text).not.toContain('レシートです');
  });
  it('何もないときと、大きすぎる写真は断る', async () => {
    const t = setup();
    await expect(t.call('parse', {})).rejects.toMatchObject({ code: 'empty' });
    await expect(t.call('parse', { image: { data: 'A'.repeat(6_000_001), mime: 'image/jpeg' } })).rejects.toMatchObject({ code: 'too_big' });
  });
});

describe('提案', () => {
  async function filled() {
    const t = setup();
    await t.call('add', {
      items: [
        { name: '卵', category: '卵・乳製品', days: 14 },
        { name: '豚こま肉', category: '肉', days: 1 },
        { name: '小松菜', category: '野菜', days: 2 },
      ],
    });
    return t;
  }

  it('冷蔵庫が空なら、先に食材を入れるよう伝える', async () => {
    await expect(setup().call('suggest', { scene: 'tired' })).rejects.toMatchObject({ code: 'no_items' });
  });
  it('3品を保存して返す。指示文には期限の近い順の食材と場面が入る', async () => {
    const t = await filled();
    const res = await t.call('suggest', { scene: 'bento' });
    expect(res.recipes).toHaveLength(3);
    expect(res.recipes[0].scene).toBe('bento');
    expect(res.recipes[0].ingredients[0]).toMatchObject({ source: 'fridge', name: '豚こま肉' });
    expect(res.recipes[0].ingredients[0].itemId).toBeTruthy();
    const prompt = t.ai.calls.at(-1)!.text;
    expect(prompt.indexOf('豚こま肉(あと1日)')).toBeLessThan(prompt.indexOf('小松菜(あと2日)'));
    expect(prompt.indexOf('小松菜(あと2日)')).toBeLessThan(prompt.indexOf('卵(あと14日)'));
    expect(prompt).toContain('お弁当');
  });
  it('2回目は、前に出した料理を避けるよう頼む', async () => {
    const t = await filled();
    const first = await t.call('suggest', { scene: 'tired' });
    await t.call('suggest', { scene: 'tired' });
    expect(t.ai.calls.at(-1)!.text).toContain(first.recipes[0].title);
  });
  it('設定(人数・苦手なもの)が指示文に入る', async () => {
    const t = await filled();
    await t.call('settings', { settings: { servings: 3, dislikes: 'パクチー' } });
    const res = await t.call('suggest', { scene: 'holiday' });
    expect(res.recipes[0].servings).toBe(3);
    expect(t.ai.calls.at(-1)!.text).toContain('3人分');
    expect(t.ai.calls.at(-1)!.text).toContain('パクチー');
  });
  it('指定の1品だけ作れる(買い物の画面から)', async () => {
    const t = await filled();
    const res = await t.call('suggest', { scene: 'tired', dish: '麻婆豆腐', buy: '長ねぎ' });
    expect(res.recipes).toHaveLength(1);
    expect(res.recipes[0].title).toBe('麻婆豆腐');
    expect(res.recipes[0].ingredients.some((i: any) => i.source === 'buy' && i.name === '長ねぎ')).toBe(true);
  });
  it('文章の上限を超えると断る', async () => {
    const t = setup({ images: 5, texts: 1 });
    await t.call('add', { items: [{ name: '卵', category: '卵・乳製品', days: 14 }] });
    await t.call('suggest', { scene: 'tired' });
    await expect(t.call('suggest', { scene: 'tired' })).rejects.toMatchObject({ code: 'limit', status: 429 });
  });
});

describe('写真', () => {
  it('作って保存し、2回目は作り直さない。上限を超えたら作らない', async () => {
    const t = setup({ images: 2, texts: 100 });
    await t.call('add', { items: [{ name: '卵', category: '卵・乳製品', days: 14 }] });
    const { recipes } = (await t.call('suggest', { scene: 'tired' })) as { recipes: Recipe[] };
    const a = await t.call('image', { id: recipes[0].id });
    expect(a.url).toMatch(/^data:image\/jpeg/);
    const again = await t.call('image', { id: recipes[0].id });
    expect(again.url).toBe(a.url);
    expect(t.ai.calls.filter((c) => c.kind === 'image')).toHaveLength(1);
    await t.call('image', { id: recipes[1].id });
    expect(await t.call('image', { id: recipes[2].id })).toEqual({ capped: true });
    expect((await t.call('sync')).usage.images).toBe(2);
  });
  it('3枚を同時に頼まれても、数えもれしない', async () => {
    const t = setup();
    await t.call('add', { items: [{ name: '卵', category: '卵・乳製品', days: 14 }] });
    const { recipes } = (await t.call('suggest', { scene: 'tired' })) as { recipes: Recipe[] };
    await Promise.all(recipes.map((r) => t.call('image', { id: r.id })));
    expect((await t.call('sync')).usage.images).toBe(3);
  });
  it('ないレシピは 404', async () => {
    await expect(setup().call('image', { id: 'nope' })).rejects.toMatchObject({ status: 404 });
  });
  it('写真の指示文は、調味料以外の材料だけに絞る', () => {
    const p = prompts.image({
      id: 'x', scene: 'tired', title: '豚こまの炒めもの', lead: '', minutes: 10, servings: 1, steps: [], tip: '', imageUrl: null, cookedAt: null, createdAt: '',
      ingredients: [
        { name: '豚こま肉', amount: '', source: 'fridge' },
        { name: '醤油', amount: '', source: 'pantry' },
        { name: '長ねぎ', amount: '', source: 'buy' },
      ],
    });
    expect(p).toContain('豚こま肉、長ねぎ だけ');
    expect(p).not.toContain('醤油');
  });
});

describe('作った!', () => {
  it('使い切ったものだけが冷蔵庫から消える', async () => {
    const t = setup();
    const { items } = await t.call('add', {
      items: [
        { name: '豚こま肉', category: '肉', days: 3 },
        { name: '卵', category: '卵・乳製品', days: 14 },
      ],
    });
    const { recipes } = await t.call('suggest', { scene: 'tired' });
    const res = await t.call('cooked', { id: recipes[0].id, usedUp: [items[0].id] });
    expect(res.items.map((i: Item) => i.name)).toEqual(['卵']);
    expect((await t.store.getRecipe(recipes[0].id))!.cookedAt).toBe(NOW.toISOString());
  });
});

describe('買い物', () => {
  it('冷蔵庫が同じ間は、AI を呼び直さない', async () => {
    const t = setup();
    expect((await t.call('shopping')).ideas).toEqual([]);
    await t.call('add', { items: [{ name: '豚こま肉', category: '肉', days: 3 }, { name: '絹豆腐', category: '大豆製品', days: 5 }] });
    const a = await t.call('shopping');
    expect(a.ideas).toHaveLength(4);
    expect(a.ideas[0]).toMatchObject({ buy: '長ねぎ' });
    await t.call('shopping');
    expect(t.ai.calls.filter((c) => c.kind === 'shopping')).toHaveLength(1);
    await t.call('add', { items: [{ name: '卵', category: '卵・乳製品', days: 14 }] });
    await t.call('shopping');
    expect(t.ai.calls.filter((c) => c.kind === 'shopping')).toHaveLength(2);
  });
});

describe('そのほか', () => {
  it('知らない操作は断る', async () => {
    await expect(setup().call('drop_everything')).rejects.toMatchObject({ status: 404 });
  });
  it('設定は範囲内の値に直して保存する', async () => {
    const t = setup();
    expect((await t.call('settings', { settings: { servings: 99, dislikes: 'x'.repeat(500) } })).settings).toEqual({ servings: 6, dislikes: 'x'.repeat(200) });
  });
});
