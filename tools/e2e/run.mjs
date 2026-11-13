// 画面の通しテスト。4つの画面サイズで、登録 → 提案 → レシピ → 作った → 買い物 までを動かし、
// 表示の切れ・画面の切り替えの速さ・エラーを調べる。
//   先に:npm run api / npm run dev      実行:npm run e2e [サイズ名…]
import { fileURLToPath } from 'node:url';
import { apiCall, apiTest, launch, openPage, OUT, SIZES, sleep } from './lib.mjs';

const only = process.argv.slice(2);
const sizes = Object.keys(SIZES).filter((s) => !only.length || only.includes(s));
const RECEIPT = fileURLToPath(new URL('../fixtures/dish.jpg', import.meta.url));
const problems = [];
const timings = [];
const browser = await launch();

for (const size of sizes) {
  try {
  await apiTest({ reset: true, delay: 700, fail: false });
  const note = (msg) => problems.push(`[${size}] ${msg}`);
  let h;
  const expect = (cond, msg) => cond || note(msg);

  // ── 合言葉の扉 ──
  h = await openPage(browser, { size, pass: null });
  const check = async (name) => {
    await sleep(260); // 出てくる動きが終わるのを待つ
    await h.shot(name);
    for (const b of await h.layout()) note(`${name}: ${b}`);
  };
  /** 押してから次の画面が出るまでの時間を測る(通信を待たずに切り替わるはず) */
  const quick = async (label, tapText, appears, opt) => {
    const t0 = Date.now();
    await h.tap(tapText, opt);
    await h.waitText(appears, 3000);
    const ms = Date.now() - t0;
    timings.push(`[${size}] ${label}: ${ms}ms`);
    if (ms > 200) note(`${label} の切り替えに ${ms}ms かかった`);
  };

  await h.waitText('合言葉');
  await check('01-door');
  await h.page.type('#pass', 'chigau');
  await h.tap('扉を開ける');
  await h.waitText('合言葉が違います');
  await check('02-door-error');
  await h.page.evaluate(() => (document.querySelector('#pass').value = ''));
  await h.page.click('#pass', { clickCount: 3 });
  await h.page.type('#pass', 'test-pass');
  await h.tap('扉を開ける');
  await h.waitText('なにを作ろう');
  await sleep(1300);
  expect(!(await h.page.$('.door')), '扉が開いたあとも残っている');
  await check('03-home-empty');

  // ── 冷蔵庫(空)──
  await quick('ホーム→冷蔵庫', '冷蔵庫', '冷蔵庫は空です', { exact: true });
  await check('04-fridge-empty');

  // ── いつもの:押した瞬間に入る ──
  await h.tap('いつもの');
  await h.waitText('押すとすぐ冷蔵庫に入ります');
  await check('05-picks');
  await h.tap('卵', { exact: true });
  await h.tap('牛乳', { exact: true });
  await check('06-picks-added');
  await h.tap('2品を入れました。閉じる');
  const t1 = Date.now();
  await h.waitText('牛乳');
  expect(Date.now() - t1 < 150, 'いつものを押してから一覧に出るまでが遅い');
  await check('07-fridge-two');

  // ── 話す・打つ:知っている食材名だけなら、AI を待たずに出る ──
  await h.tap('話す・打つ');
  await h.page.waitForSelector('.sheet textarea');
  await check('08-text-input');
  await h.page.type('.sheet textarea', '納豆、もやし');
  const t2 = Date.now();
  await h.tap('読み取る');
  await h.waitText('2品を見つけました');
  expect(Date.now() - t2 < 200, '知っている食材なのに、読み取りを待たされた');
  await h.tap('2品を冷蔵庫に入れる');
  await h.waitGone('.sheet');

  // ── 話す・打つ:文章は AI が読む。待つ間も画面は出ている ──
  await h.tap('話す・打つ');
  await h.page.waitForSelector('.sheet textarea');
  await h.page.type('.sheet textarea', '今日は豚こまと小松菜と絹豆腐を買った');
  await h.tap('読み取る');
  await h.waitText('読み取っています', 1000);
  await check('09-text-reading');
  await h.waitText('3品を見つけました');
  await check('10-text-confirm');
  // 日数を変える・1つ外す・もれたものを足す
  await h.tap('小松菜の日数を増やす');
  await h.tap('絹豆腐を外す');
  await h.page.type('.add-one input', 'しめじ');
  await h.tap('足す', { exact: true });
  await h.waitText('しめじ');
  await check('11-text-confirm-edited');
  await h.tap('3品を冷蔵庫に入れる');
  await h.waitGone('.sheet');
  await h.waitText('しめじ');

  // ── レシートを撮る ──
  const input = await h.page.$('[data-testid="receipt-input"]');
  await input.uploadFile(RECEIPT);
  await h.waitText('読み取っています', 2000);
  await check('12-receipt-reading');
  await h.waitText('品を見つけました');
  await check('13-receipt-confirm');
  await h.tap('冷蔵庫に入れる');
  await h.waitGone('.sheet');
  // 冷蔵庫の中を撮ったときは、もう入っているものを外す
  await (await h.page.$('[data-testid="photo-input"]')).uploadFile(RECEIPT);
  await h.waitText('新しいものはありません');
  await check('13b-photo-nothing-new');
  await h.tap('閉じる', { exact: true });
  await h.waitGone('.sheet');
  await sleep(900); // サーバーとの同期が終わるのを待つ
  await check('14-fridge-full');
  const names = await h.page.$$eval('.row-name', (els) => els.map((e) => e.textContent));
  for (const n of ['卵', '牛乳', '納豆', 'もやし', '豚こま肉', '小松菜', 'しめじ', '絹豆腐']) expect(names.includes(n), `冷蔵庫に ${n} がない(${names.join(',')})`);
  const server = (await apiCall('sync')).items.map((i) => i.name);
  expect(server.length === names.length, `サーバーの数(${server.length})と画面の数(${names.length})が合わない`);

  // ── 1つを直す・なくす ──
  await h.tap('もやし');
  await h.waitText('おいしく食べられる日数の目安です');
  await check('15-item-sheet');
  await h.tap('今日まで');
  await h.tap('閉じる', { exact: true });
  await h.waitGone('.sheet');
  await h.waitText('今日まで');
  const milk = () => h.page.$$eval('.row-name', (els) => els.filter((e) => e.textContent === '牛乳').length);
  const before = await milk();
  await h.tap('牛乳');
  await h.tap('もうない');
  await h.waitGone('.sheet');
  await sleep(300);
  expect((await milk()) === before - 1, '牛乳が1つ減っていない');
  await check('16-fridge-after-remove');

  // ── ホーム ──
  await quick('冷蔵庫→ホーム', 'ホーム', 'なにを作ろう', { exact: true });
  await check('17-home');

  // ── 提案:押した瞬間に次の画面が出て、中身はあとから届く ──
  await quick('ホーム→提案', 'お弁当', '考えています');
  await check('18-scene-loading');
  await h.waitText('別の3品を見る');
  await check('19-scene-text');
  await h.page.waitForFunction(() => document.querySelectorAll('.dish .photo img.on').length === 3, { timeout: 15000 });
  await check('20-scene-photos');
  await h.page.evaluate(() => document.querySelector('.screen').scrollTo(0, 99999));
  await check('21-scene-bottom');

  // ── レシピ ──
  const title = await h.page.$eval('.dish-title', (e) => e.textContent);
  await quick('提案→レシピ', title, '作り方');
  await check('22-recipe');
  await h.page.evaluate(() => document.querySelector('.screen').scrollTo(0, 99999));
  await check('23-recipe-bottom');
  expect((await h.page.$eval('.outlink', (a) => a.href)).includes('google.com/search'), '似たレシピのリンクがない');

  // ── 作った! ──
  await h.tap('作った!');
  await h.waitText('使い切ったものを押してください');
  await check('24-cooked');
  const usedName = await h.page.$eval('.sheet .pick', (e) => e.textContent.trim());
  await h.tap(usedName, { exact: true });
  await h.tap('1品を冷蔵庫から出す');
  await h.waitText('なにを作ろう');
  await check('25-home-after-cooked');
  await sleep(900);
  expect(!(await apiCall('sync')).items.some((i) => i.name === usedName), `${usedName} がサーバーに残っている`);

  // ── もう一度同じ場面:冷蔵庫が変わったので作り直す。別の3品も試す ──
  await h.tap('つかれた日');
  await h.waitText('別の3品を見る', 15000);
  await h.tap('別の3品を見る');
  await h.waitText('考えています', 1000);
  await h.waitText('別の3品を見る', 15000);
  await h.tap('もどる');
  await h.waitText('なにを作ろう');

  // ── 買い物 ──
  await quick('ホーム→買い物', '買い物', 'あと1つ買えば', { exact: true });
  await check('26-shop-loading');
  await h.waitText('を買うと');
  await check('27-shop');
  await quick('買い物→レシピ', '長ねぎ', '豚こまの麻婆豆腐');
  await check('28-idea-loading');
  await h.waitText('作り方');
  await check('29-idea-recipe');
  await h.tap('もどる');
  await h.waitText('あと1つ買えば');

  // ── 設定 ──
  await h.tap('ホーム', { exact: true });
  await h.tap('設定');
  await h.waitText('何人分で提案するか');
  await h.tap('人数を増やす');
  await h.page.type('input[aria-label="使わないもの"]', 'パクチー');
  await h.page.$eval('input[aria-label="使わないもの"]', (e) => e.blur());
  await check('30-settings');
  await sleep(500);
  const set = (await apiCall('sync')).settings;
  expect(set.servings === 2 && set.dislikes === 'パクチー', `設定が保存されていない ${JSON.stringify(set)}`);

  // ── 開き直しても、合言葉なしですぐ使える(中身は手元に残っている)──
  await h.page.reload({ waitUntil: 'domcontentloaded' });
  await h.waitText('何人分で提案するか', 3000);
  expect(!(await h.text()).includes('扉を開ける'), '開き直したら合言葉を聞かれた');

  // ── うまくいかないとき ──
  await apiTest({ fail: true, delay: 200 });
  await h.page.evaluate(() => { location.hash = '/s/bento'; window.dispatchEvent(new PopStateEvent('popstate')); });
  await h.waitText('提案を作れませんでした');
  await check('31-scene-error');
  await apiTest({ fail: false });
  await h.tap('もう一度ためす');
  await h.waitText('別の3品を見る', 15000);

  for (const e of h.errors) note(`ブラウザのエラー: ${e}`);
  await h.page.close();
  } catch (e) {
    problems.push(`[${size}] 途中で止まった: ${String(e).split('\n')[0]} ${(e.stack ?? '').match(/run\.mjs:\d+/)?.[0] ?? ''}`);
  }
}

await browser.close();
console.log(timings.join('\n'));
console.log(`\n画面の写し: ${OUT}`);
if (problems.length) {
  console.log(`\n問題 ${problems.length}件:\n` + problems.join('\n'));
  process.exit(1);
}
console.log('\n問題なし');
