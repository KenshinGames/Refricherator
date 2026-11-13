// 提案の画面と、レシピの画面。
import { useEffect, useState } from 'react';
import { batchFor, cooked, daysLeft, ideaKey, loadIdea, loadScene, toast, useStore } from './store.ts';
import type { Item, Recipe, Scene } from './store.ts';
import { back, go, Icon, Photo, Sheet } from './ui.tsx';

export const SCENE_INFO: Record<Scene, { name: string; note: string; icon: string; waiting: string }> = {
  tired: { name: 'つかれた日', note: '15分でさっと', icon: 'moon', waiting: 'さっと作れるものを考えています' },
  holiday: { name: '休みの日', note: 'ちょっと気合いを入れて', icon: 'sun', waiting: '腕をふるえるものを考えています' },
  bento: { name: 'お弁当', note: '明日の分を作っておく', icon: 'bento', waiting: '冷めてもおいしいものを考えています' },
};

/** レシピを見ている間は、画面が勝手に消えないようにする(対応している端末だけ) */
function useWakeLock(): void {
  useEffect(() => {
    type Lock = { release(): Promise<void> };
    const wl = (navigator as { wakeLock?: { request(type: 'screen'): Promise<Lock> } }).wakeLock;
    if (!wl) return;
    let lock: Lock | null = null;
    let off = false;
    const hold = () => {
      if (document.visibilityState !== 'visible') return;
      wl.request('screen').then(
        (l) => {
          if (off) void l.release();
          else lock = l;
        },
        () => {},
      );
    };
    hold();
    document.addEventListener('visibilitychange', hold);
    return () => {
      off = true;
      document.removeEventListener('visibilitychange', hold);
      void lock?.release().catch(() => {});
    };
  }, []);
}

function TopBar({ title, fallback = '/' }: { title: string; fallback?: string }) {
  return (
    <header className="bar">
      <button className="round" aria-label="もどる" onClick={() => back(fallback)}>
        <Icon name="left" size={22} />
      </button>
      <h1>{title}</h1>
    </header>
  );
}

function EmptyFridge() {
  return (
    <div className="empty">
      <p className="empty-title">まず、冷蔵庫に食材を入れましょう</p>
      <p>家にあるものが分かると、それに合わせた料理を提案できます。</p>
      <button className="btn" onClick={() => go('/fridge', true)}>
        食材を入れる
      </button>
    </div>
  );
}

function DishSkeleton() {
  return (
    <div className="dish dish-skel" aria-hidden="true">
      <div className="photo photo-wait" />
      <span className="skel" style={{ width: '68%', height: 22 }} />
      <span className="skel" style={{ width: '86%' }} />
      <span className="skel" style={{ width: '40%' }} />
    </div>
  );
}

/** その料理で使う、期限の近い食材(あと3日まで) */
function soonUsed(recipe: Recipe, items: Item[]): Item[] {
  const ids = new Set(recipe.ingredients.map((i) => i.itemId).filter(Boolean));
  return items.filter((i) => ids.has(i.id) && daysLeft(i) <= 3);
}

function DishCard({ recipe, items }: { recipe: Recipe; items: Item[] }) {
  const buy = recipe.ingredients.filter((i) => i.source === 'buy');
  const soon = soonUsed(recipe, items);
  return (
    <button className="dish" onClick={() => go(`/r/${recipe.id}`)}>
      <Photo recipe={recipe} />
      <span className="dish-title">{recipe.title}</span>
      {recipe.lead && <span className="dish-lead">{recipe.lead}</span>}
      <span className="dish-meta">
        <span className="meta">
          <Icon name="clock" size={16} />
          {recipe.minutes}分
        </span>
        {buy.length === 0 ? <span className="tag tag-home">家にあるものだけ</span> : <span className="tag tag-buy">買い足し:{buy.map((b) => b.name).join('、')}</span>}
      </span>
      {soon.length > 0 && <span className="dish-soon">{soon.map((s) => s.name).join('・')}を使い切れます</span>}
    </button>
  );
}

export function SceneScreen({ scene }: { scene: Scene }) {
  const info = SCENE_INFO[scene];
  const items = useStore((s) => s.items);
  const batch = useStore((s) => batchFor(s, scene)?.map((r) => r.id).join(',') ?? '');
  const recipes = useStore((s) => s.recipes);
  const loading = useStore((s) => !!s.sceneLoading[scene]);
  const error = useStore((s) => s.sceneError[scene]);
  const list = batch ? batch.split(',').map((id) => recipes[id]).filter(Boolean) : [];

  useEffect(() => {
    void loadScene(scene);
  }, [scene, items.length]);

  return (
    <div className="screen">
      <TopBar title={info.name} />
      {items.length === 0 ? (
        <EmptyFridge />
      ) : loading || (!list.length && !error) ? (
        <>
          <p className="waiting" role="status">
            <span className="pulse" />
            {info.waiting}
          </p>
          <DishSkeleton />
          <DishSkeleton />
          <DishSkeleton />
        </>
      ) : error ? (
        <div className="empty">
          <p className="empty-title">提案を作れませんでした</p>
          <p>{error}</p>
          <button className="btn" onClick={() => void loadScene(scene)}>
            もう一度ためす
          </button>
        </div>
      ) : (
        <>
          <p className="lede">期限の近いものから使う3品です。</p>
          {list.map((r) => (
            <DishCard key={r.id} recipe={r} items={items} />
          ))}
          {list.length > 0 && (
            <button className="btn btn-line" onClick={() => void loadScene(scene, true)}>
              <Icon name="redo" size={18} />
              別の3品を見る
            </button>
          )}
        </>
      )}
    </div>
  );
}

// ───────── レシピ ─────────

const SOURCE_LABEL = { fridge: '冷蔵庫から', buy: '買い足す', pantry: '調味料など' } as const;

function RecipeBody({ recipe }: { recipe: Recipe }) {
  const items = useStore((s) => s.items);
  const [asking, setAsking] = useState(false);
  const [done, setDone] = useState<number[]>([]);
  useWakeLock();
  const groups = (['fridge', 'buy', 'pantry'] as const).map((src) => ({ src, list: recipe.ingredients.filter((i) => i.source === src) })).filter((g) => g.list.length);
  const used = items.filter((i) => recipe.ingredients.some((g) => g.itemId === i.id));

  return (
    <>
      <div className="recipe-hero">
        <Photo recipe={recipe} className="photo-hero" />
        <button className="round round-float" aria-label="もどる" onClick={() => back('/')}>
          <Icon name="left" size={22} />
        </button>
      </div>
      <div className="recipe">
        <h1 className="recipe-title">{recipe.title}</h1>
        {recipe.lead && <p className="recipe-lead">{recipe.lead}</p>}
        <p className="recipe-meta">
          <span className="meta">
            <Icon name="clock" size={16} />
            {recipe.minutes}分
          </span>
          <span className="meta">{recipe.servings}人分</span>
        </p>

        <h2>材料</h2>
        {groups.map((g) => (
          <div key={g.src} className={`ing ing-${g.src}`}>
            <h3>{SOURCE_LABEL[g.src]}</h3>
            <ul>
              {g.list.map((i, n) => (
                <li key={n}>
                  <span>{i.name}</span>
                  <span className="amount">{i.amount}</span>
                </li>
              ))}
            </ul>
          </div>
        ))}

        <h2>作り方</h2>
        <ol className="steps">
          {recipe.steps.map((s, n) => {
            const on = done.includes(n);
            return (
              <li key={n}>
                <button className={on ? 'done' : ''} aria-pressed={on} onClick={() => setDone((d) => (on ? d.filter((x) => x !== n) : [...d, n]))}>
                  <span className="step-n">{on ? <Icon name="check" size={18} /> : n + 1}</span>
                  <span>{s}</span>
                </button>
              </li>
            );
          })}
        </ol>

        {recipe.tip && (
          <p className="tip">
            <b>コツ</b>
            {recipe.tip}
          </p>
        )}

        <a className="outlink" href={`https://www.google.com/search?q=${encodeURIComponent(recipe.title + ' レシピ')}`} target="_blank" rel="noopener noreferrer">
          似たレシピをネットで見る
          <Icon name="out" size={18} />
        </a>
      </div>

      <div className="dock">
        {recipe.cookedAt ? (
          <button className="btn btn-done" onClick={() => setAsking(true)}>
            <Icon name="check" size={20} />
            作りました
          </button>
        ) : (
          <button className="btn" onClick={() => setAsking(true)}>
            作った!
          </button>
        )}
      </div>

      {asking && <CookedSheet recipe={recipe} used={used} onClose={() => setAsking(false)} />}
    </>
  );
}

function CookedSheet({ recipe, used, onClose }: { recipe: Recipe; used: Item[]; onClose: () => void }) {
  const [gone, setGone] = useState<string[]>([]);
  const finish = () => {
    cooked(recipe.id, gone);
    toast(gone.length ? `おつかれさまでした。${gone.length}品を使い切りました` : 'おつかれさまでした');
    onClose();
    go('/', true);
  };
  return (
    <Sheet
      title="おつかれさまでした"
      onClose={onClose}
      footer={
        <button className="btn" onClick={finish}>
          {gone.length ? `${gone.length}品を冷蔵庫から出す` : used.length ? '使い切ったものはない' : 'ホームにもどる'}
        </button>
      }
    >
      {used.length === 0 ? (
        <p className="hint">冷蔵庫の中身はそのままにしておきます。</p>
      ) : (
        <>
          <p className="hint">使い切ったものを押してください。冷蔵庫から出しておきます。</p>
          <div className="picks">
            {used.map((i) => {
              const on = gone.includes(i.id);
              return (
                <button key={i.id} className={`pick pick-big ${on ? 'pick-on' : ''}`} aria-pressed={on} onClick={() => setGone((g) => (on ? g.filter((x) => x !== i.id) : [...g, i.id]))}>
                  {on && <Icon name="check" size={16} />}
                  {i.name}
                </button>
              );
            })}
          </div>
        </>
      )}
    </Sheet>
  );
}

function RecipeSkeleton({ title, note }: { title: string; note: string }) {
  return (
    <>
      <div className="recipe-hero">
        <div className="photo photo-hero photo-wait" />
        <button className="round round-float" aria-label="もどる" onClick={() => back('/shop')}>
          <Icon name="left" size={22} />
        </button>
      </div>
      <div className="recipe">
        <h1 className="recipe-title">{title}</h1>
        <p className="waiting" role="status">
          <span className="pulse" />
          {note}
        </p>
        {[90, 70, 82, 60].map((w) => (
          <span key={w} className="skel skel-line" style={{ width: `${w}%` }} />
        ))}
      </div>
    </>
  );
}

export function RecipeScreen({ id }: { id: string }) {
  const recipe = useStore((s) => s.recipes[id]);
  return (
    <div className="screen screen-flush">
      {recipe ? (
        <RecipeBody recipe={recipe} />
      ) : (
        <>
          <TopBar title="レシピ" />
          <div className="empty">
            <p className="empty-title">このレシピは見つかりませんでした</p>
            <p>もう一度、場面を選んで提案を見てください。</p>
            <button className="btn" onClick={() => go('/', true)}>
              ホームにもどる
            </button>
          </div>
        </>
      )}
    </div>
  );
}

/** 買い物の案から開いたレシピ(料理名は分かっているので、すぐ画面を出して中身を待つ) */
export function IdeaScreen({ buy, dish }: { buy: string; dish: string }) {
  const key = ideaKey({ buy, dish });
  const recipe = useStore((s) => (s.ideaRecipe[key] ? s.recipes[s.ideaRecipe[key]] : undefined));
  const error = useStore((s) => s.ideaError[key]);
  useEffect(() => {
    void loadIdea({ buy, dish });
  }, [buy, dish]);
  return (
    <div className="screen screen-flush">
      {recipe ? (
        <RecipeBody recipe={recipe} />
      ) : error ? (
        <>
          <TopBar title={dish} fallback="/shop" />
          <div className="empty">
            <p className="empty-title">レシピを作れませんでした</p>
            <p>{error}</p>
            <button className="btn" onClick={() => void loadIdea({ buy, dish })}>
              もう一度ためす
            </button>
          </div>
        </>
      ) : (
        <RecipeSkeleton title={dish} note={`${buy}を買い足す作り方を書いています`} />
      )}
    </div>
  );
}
