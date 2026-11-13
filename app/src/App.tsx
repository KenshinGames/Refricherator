// 全体の組み立て:扉、ホーム、買い物、設定、下のタブ。
import { useEffect, useState } from 'react';
import { IdeaScreen, RecipeScreen, SCENE_INFO, SceneScreen } from './Cook.tsx';
import { Fridge } from './Fridge.tsx';
import { batchFor, daysLeft, enter, leave, likelyScene, loadShopping, saveSettings, useStore } from './store.ts';
import type { Scene } from './store.ts';
import { back, go, Icon, ideaPath, leftLabel, leftTone, Ring, Stepper, Toast, useRoute, useVisualViewport } from './ui.tsx';

const SCENE_ORDER: Scene[] = ['tired', 'holiday', 'bento'];
const WEEK = ['日', '月', '火', '水', '木', '金', '土'];

export function App() {
  useVisualViewport();
  const pass = useStore((s) => s.pass);
  const route = useRoute();
  const tab = route.name === 'home' || route.name === 'fridge' || route.name === 'shop' ? route.name : null;
  const key = route.name + ('scene' in route ? route.scene : '') + ('id' in route ? route.id : '') + ('dish' in route ? route.dish : '');

  return (
    <div className="app">
      {pass && (
        <>
          <main className={tab ? 'stage stage-tabs' : 'stage'} key={key}>
            {route.name === 'home' && <Home />}
            {route.name === 'fridge' && <Fridge />}
            {route.name === 'shop' && <Shop />}
            {route.name === 'settings' && <Settings />}
            {route.name === 'scene' && <SceneScreen scene={route.scene} />}
            {route.name === 'recipe' && <RecipeScreen id={route.id} />}
            {route.name === 'idea' && <IdeaScreen buy={route.buy} dish={route.dish} />}
          </main>
          {tab && (
            <nav className="tabs" aria-label="メニュー">
              {(
                [
                  ['home', '/', 'ホーム', 'home'],
                  ['fridge', '/fridge', '冷蔵庫', 'fridge'],
                  ['shop', '/shop', '買い物', 'basket'],
                ] as const
              ).map(([name, path, label, icon]) => (
                <button key={name} className={tab === name ? 'on' : ''} aria-current={tab === name ? 'page' : undefined} onClick={() => tab !== name && go(path, true)}>
                  <Icon name={icon} />
                  {label}
                </button>
              ))}
            </nav>
          )}
          <Toast />
        </>
      )}
      <Door locked={!pass} />
    </div>
  );
}

// ───────── 扉 ─────────

function Door({ locked }: { locked: boolean }) {
  // 鍵がかかっている間は閉じたまま。開いたら、開く動きのあとで片づける
  const [gone, setGone] = useState(false);
  const [word, setWord] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (locked) {
      setGone(false);
      return;
    }
    const t = setTimeout(() => setGone(true), 1150);
    return () => clearTimeout(t);
  }, [locked]);
  if (gone) return null;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!word.trim() || busy) return;
    setBusy(true);
    setError('');
    const problem = await enter(word);
    setBusy(false);
    if (problem) setError(problem);
  };

  return (
    <div className={`door ${locked ? 'door-locked' : 'door-open'}`} aria-hidden={!locked}>
      <div className="door-leaf">
        <span className="door-handle" />
        <div className="door-face">
          <p className="wordmark">Refricherator</p>
          <p className="door-tag">冷蔵庫を、リッチに使い切る。</p>
          {locked && (
            <form className="door-form" onSubmit={submit}>
              <label htmlFor="pass">合言葉</label>
              <input id="pass" className="field field-dark" value={word} onChange={(e) => setWord(e.target.value)} autoComplete="off" autoCapitalize="none" spellCheck={false} enterKeyHint="go" />
              {error && (
                <p className="door-error" role="alert">
                  {error}
                </p>
              )}
              <button className="btn btn-light" disabled={!word.trim() || busy}>
                {busy ? '確かめています' : '扉を開ける'}
              </button>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}

// ───────── ホーム ─────────

function SceneCard({ scene, big }: { scene: Scene; big: boolean }) {
  const info = SCENE_INFO[scene];
  // 提案がもう用意できていれば、その1品目を見せる(写真があれば写真も)
  const ids = useStore((s) => batchFor(s, scene)?.map((r) => r.id).join(',') ?? '');
  const recipes = useStore((s) => s.recipes);
  const ready = ids ? ids.split(',').map((id) => recipes[id]).filter(Boolean) : [];
  const photo = ready.find((r) => r.imageUrl)?.imageUrl;
  return (
    <button className={`scene ${big ? 'scene-big' : ''}`} onClick={() => go(`/s/${scene}`)}>
      <img src={photo ?? `./covers/${scene}.jpg`} alt="" decoding="async" />
      <span className="scene-name">{info.name}</span>
      <span className="scene-note">{big && ready.length ? `${ready[0].title} ほか${ready.length - 1}品` : info.note}</span>
    </button>
  );
}

function Home() {
  const items = useStore((s) => s.items);
  const now = new Date();
  const soon = items.filter((i) => daysLeft(i) <= 3).slice(0, 6);
  // いま開きそうな場面(平日はつかれた日、土日は休みの日)を大きく出す
  const first = likelyScene(now);
  const order = [first, ...SCENE_ORDER.filter((s) => s !== first)];
  return (
    <div className="screen home">
      <header className="home-head">
        <p className="date">
          {now.getMonth() + 1}月{now.getDate()}日 {WEEK[now.getDay()]}曜日
        </p>
        <button className="round" aria-label="設定" onClick={() => go('/settings')}>
          <Icon name="gear" size={22} />
        </button>
      </header>
      <h1 className="ask">{now.getHours() < 15 ? '今日、なに作る?' : '今夜、なに作る?'}</h1>

      <div className="scenes">
        {order.map((s, n) => (
          <SceneCard key={s} scene={s} big={n === 0} />
        ))}
      </div>

      <section className="soon">
        {items.length === 0 ? (
          <div className="empty">
            <p className="empty-title">冷蔵庫は空です</p>
            <p>家にあるものを入れると、それに合わせた料理を提案します。</p>
            <button className="btn" onClick={() => go('/fridge', true)}>
              食材を入れる
            </button>
          </div>
        ) : (
          <>
            <div className="sec-head">
              <h2>そろそろ使い切りたい</h2>
              <button className="sec-link" onClick={() => go('/fridge', true)}>
                冷蔵庫を見る
              </button>
            </div>
            {soon.length === 0 ? (
              <p className="quiet">急いで使うものはありません。</p>
            ) : (
              <ul className="soon-list">
                {soon.map((i) => (
                  <li key={i.id}>
                    <button onClick={() => go('/fridge', true)} aria-label={`${i.name} ${leftLabel(daysLeft(i))}`}>
                      <Ring item={i} size={52} />
                      {i.name}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </section>
    </div>
  );
}

// ───────── 買い物 ─────────

function Shop() {
  const items = useStore((s) => s.items);
  const shopping = useStore((s) => s.shopping);
  const loading = useStore((s) => s.shoppingLoading);
  const error = useStore((s) => s.shoppingError);
  useEffect(() => {
    void loadShopping();
  }, [items]);
  const ideas = shopping?.ideas ?? [];

  return (
    <div className="screen">
      <header className="title-row">
        <h1>買い物</h1>
      </header>
      {items.length === 0 ? (
        <div className="empty">
          <p className="empty-title">冷蔵庫は空です</p>
          <p>家にあるものを入れておくと、「あと1つ買えば作れる料理」をここに出します。</p>
          <button className="btn" onClick={() => go('/fridge', true)}>
            食材を入れる
          </button>
        </div>
      ) : (
        <>
          <p className="lede">あと1つ買えば、今夜これが作れます。</p>
          {loading && !ideas.length ? (
            <ul className="ideas" aria-hidden="true">
              {[0, 1, 2, 3].map((n) => (
                <li key={n} className="idea idea-skel">
                  <span className="skel" style={{ width: '34%', height: 20 }} />
                  <span className="skel" style={{ width: '72%' }} />
                </li>
              ))}
            </ul>
          ) : error && !ideas.length ? (
            <div className="empty">
              <p>{error}</p>
              <button className="btn" onClick={() => void loadShopping()}>
                もう一度ためす
              </button>
            </div>
          ) : (
            <ul className="ideas">
              {ideas.map((i) => (
                <li key={i.buy + i.dish}>
                  <button className="idea" onClick={() => go(ideaPath(i))}>
                    <span className="idea-buy">
                      <b>{i.buy}</b>を買うと
                    </span>
                    <span className="idea-dish">{i.dish}</span>
                    <span className="idea-uses">
                      {i.uses.length > 0 && <>{[...new Set(i.uses)].join('・')}を使う</>}
                      <span className="meta">
                        <Icon name="clock" size={15} />
                        {i.minutes}分
                      </span>
                    </span>
                    <Icon name="right" size={20} />
                  </button>
                </li>
              ))}
            </ul>
          )}

          <section className="group">
            <h2>家にあるもの</h2>
            <ul className="have">
              {items.map((i) => (
                <li key={i.id} className={`have-${leftTone(daysLeft(i))}`}>
                  {i.name}
                </li>
              ))}
            </ul>
          </section>
        </>
      )}
    </div>
  );
}

// ───────── 設定 ─────────

function Settings() {
  const settings = useStore((s) => s.settings);
  const usage = useStore((s) => s.usage);
  const limits = useStore((s) => s.limits);
  const [dislikes, setDislikes] = useState(settings.dislikes);
  useEffect(() => setDislikes(settings.dislikes), [settings.dislikes]);
  return (
    <div className="screen">
      <header className="bar">
        <button className="round" aria-label="もどる" onClick={() => back('/')}>
          <Icon name="left" size={22} />
        </button>
        <h1>設定</h1>
      </header>

      <section className="set">
        <h2>何人分で提案するか</h2>
        <Stepper value={settings.servings} min={1} max={6} label="人数" unit="人分" onChange={(v) => saveSettings({ ...settings, servings: v })} />
      </section>

      <section className="set">
        <h2>使わないもの</h2>
        <p className="hint">苦手なものやアレルギーがあれば書いてください。提案から外します。</p>
        <input
          className="field"
          value={dislikes}
          onChange={(e) => setDislikes(e.target.value)}
          onBlur={() => dislikes.trim() !== settings.dislikes && saveSettings({ ...settings, dislikes: dislikes.trim() })}
          placeholder="例:パクチー、えび"
          aria-label="使わないもの"
          enterKeyHint="done"
        />
      </section>

      <section className="set">
        <h2>今月の料理写真</h2>
        <p className="usage">
          <b>{usage.images}</b> / {limits.images} 枚
        </p>
        <p className="hint">上限に達すると、その月は写真なしで提案します。</p>
      </section>

      <section className="set">
        <h2>合言葉</h2>
        <button className="btn btn-line" onClick={leave}>
          合言葉を入れ直す
        </button>
      </section>
    </div>
  );
}
