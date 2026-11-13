// 公開した中継サーバーに、本物の Gemini で通しの確認をする。
//   node tools/prod-check.mjs           通信・合言葉・AI のキーの確認だけ(お金はかからない)
//   node tools/prod-check.mjs setup     手元の GEMINI_API_KEY を中継サーバーに登録する(1回だけ)
//   node tools/prod-check.mjs full      読み取り・提案・写真1枚・買い物まで動かす(数円かかる)
import { readFileSync } from 'node:fs';
const URL_ = 'https://vphcejuxczbttkuzqnlv.supabase.co/functions/v1/api';
const pass = readFileSync(new URL('../.env.local', import.meta.url), 'utf8').match(/REFRICHERATOR_PASSCODE=(.+)/)[1].trim();
const mode = process.argv[2] ?? 'ping';
const call = async (action, body = {}, p = pass) => {
  const t = Date.now();
  const r = await fetch(URL_, { method: 'POST', headers: { 'content-type': 'application/json', 'x-passcode': p }, body: JSON.stringify({ action, ...body }) });
  const j = await r.json().catch(() => ({}));
  console.log(`${action} → ${r.status} ${Date.now() - t}ms`);
  return { status: r.status, j };
};
const ok = (cond, msg) => { if (!cond) { console.error('NG: ' + msg); process.exitCode = 1; } else console.log('  ok: ' + msg); };

let r = await call('ping', {}, 'wrong-pass');
ok(r.status === 401, '合言葉が違うと入れない');
r = await call('ping', {}, '');
ok(r.status === 401, '合言葉なしでは入れない');
r = await call('ping');
ok(r.status === 200, '正しい合言葉で入れる');
console.log('  AI のキー:', r.j.ai ? '登録済み' : '未登録');

if (mode === 'setup') {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('GEMINI_API_KEY が環境にありません');
  r = await call('setup', { geminiKey: key });
  ok(r.status === 200, 'キーを登録した');
  r = await call('ping');
  ok(r.j.ai === true, 'キーが登録済みになった');
}

if (mode === 'full') {
  r = await call('sync');
  ok(r.status === 200 && Array.isArray(r.j.items), `sync(食材 ${r.j.items?.length} 品、写真 ${r.j.usage?.images} 枚)`);
  r = await call('parse', { text: '豚こまと小松菜と卵を買った' });
  ok(r.j.items?.length === 3, '文章から3品を読み取る: ' + r.j.items?.map((i) => `${i.name}(${i.days}日)`).join(' '));
  const ids = r.j.items.map(() => crypto.randomUUID());
  r = await call('add', { items: r.j.items.map((i, n) => ({ ...i, id: ids[n] })) });
  ok(ids.every((id) => r.j.items.some((i) => i.id === id)), '3品を足した');
  r = await call('suggest', { scene: 'tired' });
  ok(r.j.recipes?.length === 3, '3品の提案: ' + r.j.recipes?.map((x) => x.title).join(' / '));
  const rec = r.j.recipes[0];
  r = await call('image', { id: rec.id });
  ok(/^https:\/\/.+\/dishes\//.test(r.j.url ?? ''), '写真を作って保存した: ' + r.j.url);
  const img = await fetch(r.j.url);
  ok(img.ok && img.headers.get('content-type')?.startsWith('image/'), `写真をだれでも表示できる(${img.headers.get('content-type')}, ${Math.round(Number(img.headers.get('content-length')) / 1024)}KB)`);
  r = await call('shopping');
  ok(r.j.ideas?.length >= 3, '買い物の案: ' + r.j.ideas?.map((i) => `${i.buy}→${i.dish}`).join(' / '));
  r = await call('cooked', { id: rec.id, usedUp: ids });
  ok(!r.j.items.some((i) => ids.includes(i.id)), '作った → 足した3品を冷蔵庫から出した');
}
