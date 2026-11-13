// 画面の部品(アイコン、下から出るシート、期限の印、料理写真、お知らせ)と、画面の行き来。
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';
import { loadImage, useStore } from './store.ts';
import type { Recipe, Scene } from './store.ts';

// ───────── 画面の行き来 ─────────

export type Route =
  | { name: 'home' }
  | { name: 'fridge' }
  | { name: 'shop' }
  | { name: 'settings' }
  | { name: 'scene'; scene: Scene }
  | { name: 'recipe'; id: string }
  | { name: 'idea'; buy: string; dish: string };

function parseRoute(hash: string): Route {
  const p = hash.replace(/^#\/?/, '').split('/').map(decodeURIComponent);
  if (p[0] === 'fridge') return { name: 'fridge' };
  if (p[0] === 'shop') return { name: 'shop' };
  if (p[0] === 'settings') return { name: 'settings' };
  if (p[0] === 's' && (p[1] === 'tired' || p[1] === 'holiday' || p[1] === 'bento')) return { name: 'scene', scene: p[1] };
  if (p[0] === 'r' && p[1]) return { name: 'recipe', id: p[1] };
  if (p[0] === 'i' && p[1] && p[2]) return { name: 'idea', buy: p[1], dish: p[2] };
  return { name: 'home' };
}

const routeListeners = new Set<() => void>();
let depth = 0;
const notify = () => routeListeners.forEach((l) => l());
window.addEventListener('popstate', (e) => {
  depth = (e.state as { depth?: number } | null)?.depth ?? 0;
  notify();
});

/** 次の画面へ。押した瞬間に切り替わる(通信を待たない) */
export function go(path: string, replace = false): void {
  const url = '#' + path;
  if (replace) history.replaceState({ depth }, '', url);
  else history.pushState({ depth: ++depth }, '', url);
  notify();
}
export function back(fallback = '/'): void {
  if (depth > 0) history.back();
  else go(fallback, true);
}
export function useRoute(): Route {
  const hash = useSyncExternalStore(
    (l) => {
      routeListeners.add(l);
      return () => routeListeners.delete(l);
    },
    () => location.hash,
  );
  return parseRoute(hash);
}
export const ideaPath = (i: { buy: string; dish: string }) => `/i/${encodeURIComponent(i.buy)}/${encodeURIComponent(i.dish)}`;

// ───────── アイコン(細い線) ─────────

const PATHS: Record<string, ReactNode> = {
  moon: <path d="M19.5 14.2A8 8 0 0 1 9.8 4.5a8 8 0 1 0 9.700 9.700z" />,
  sun: (
    <>
      <circle cx="12" cy="12" r="3.8" />
      <path d="M12 2.800v2M12 19.200v2M2.800 12h2M19.200 12h2M5.500 5.500l1.400 1.400M17.100 17.100l1.400 1.400M5.500 18.500l1.400-1.400M17.100 6.900l1.400-1.400" />
    </>
  ),
  bento: (
    <>
      <rect x="3" y="5.500" width="18" height="13" rx="3" />
      <path d="M12 5.500v13M3 12h9" />
    </>
  ),
  receipt: <path d="M6 3h12v18l-2.400-1.600L13.200 21 12 20.200 10.800 21l-2.400-1.600L6 21zM9 8h6M9 12h6" />,
  camera: (
    <>
      <path d="M4.500 7.500h3l1.300-2.300h6.400l1.300 2.300h3a1.500 1.500 0 0 1 1.500 1.500v8.500a1.500 1.500 0 0 1-1.500 1.500h-15A1.500 1.500 0 0 1 3 17.500V9a1.500 1.500 0 0 1 1.500-1.500z" />
      <circle cx="12" cy="13" r="3.400" />
    </>
  ),
  mic: (
    <>
      <rect x="9.200" y="3" width="5.600" height="11" rx="2.800" />
      <path d="M5.800 11.500a6.200 6.200 0 0 0 12.400 0M12 17.700V21" />
    </>
  ),
  star: <path d="M12 3.600l2.500 5.200 5.700.800-4.100 4 1 5.700-5.100-2.700-5.100 2.700 1-5.700-4.100-4 5.700-.800z" />,
  gear: (
    <>
      <circle cx="12" cy="12" r="2.800" />
      <path d="M12 3.200l1.300 2.300 2.600-.500.900 2.500 2.500.900-.500 2.600 2.300 1.300-2.300 1.300.500 2.600-2.500.900-.900 2.500-2.600-.500L12 21.100l-1.300-2.300-2.600.500-.900-2.500-2.500-.900.500-2.600L2.900 12l2.300-1.300-.500-2.600 2.500-.900.900-2.500 2.600.500z" />
    </>
  ),
  right: <path d="M9 5.500l6.500 6.500L9 18.500" />,
  left: <path d="M15 5.500L8.500 12l6.500 6.500" />,
  close: <path d="M6 6l12 12M18 6L6 18" />,
  check: <path d="M5 12.500l4.500 4.500L19 7.500" />,
  plus: <path d="M12 5v14M5 12h14" />,
  minus: <path d="M5 12h14" />,
  home: <path d="M4 11l8-6.500 8 6.500v8.500a1 1 0 0 1-1 1h-4.500v-6h-5v6H5a1 1 0 0 1-1-1z" />,
  fridge: (
    <>
      <rect x="5.500" y="2.800" width="13" height="18.400" rx="2.200" />
      <path d="M5.500 9.800h13M8.500 5.800v1.800M8.500 12.600v3" />
    </>
  ),
  basket: <path d="M3.500 9.500h17l-1.600 9a1.500 1.500 0 0 1-1.500 1.200H6.600a1.500 1.500 0 0 1-1.500-1.200zM8 9.500l3-5.500M16 9.500L13 4" />,
  clock: (
    <>
      <circle cx="12" cy="12" r="8.500" />
      <path d="M12 7.500V12l3 2" />
    </>
  ),
  out: <path d="M13.500 4.500h6v6M19.500 4.500l-8 8M10 6H6a1.500 1.500 0 0 0-1.500 1.500V18A1.500 1.500 0 0 0 6 19.500h10.500A1.500 1.500 0 0 0 18 18v-4" />,
  redo: <path d="M19.500 12a7.500 7.500 0 1 1-2.400-5.500M19.500 4v4h-4" />,
  plate: (
    <>
      <circle cx="12" cy="12" r="8.500" />
      <circle cx="12" cy="12" r="4.500" />
    </>
  ),
};

export function Icon({ name, size = 24 }: { name: keyof typeof PATHS | string; size?: number }) {
  return (
    <svg className="icon" viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {PATHS[name]}
    </svg>
  );
}

// ───────── 期限の印 ─────────

export function Stamp({ days }: { days: number }) {
  if (days < 0) return <span className="stamp stamp-over">期限すぎ</span>;
  if (days === 0) return <span className="stamp stamp-hot">今日まで</span>;
  const tone = days <= 2 ? 'stamp-hot' : days <= 7 ? 'stamp-week' : 'stamp-calm';
  return (
    <span className={`stamp ${tone}`}>
      あと<b>{days}</b>日
    </span>
  );
}

// ───────── 下から出るシート ─────────

/** キーボードが出ても隠れないよう、見えている範囲の高さを CSS に伝える */
export function useVisualViewport(): void {
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const apply = () => {
      document.documentElement.style.setProperty('--vvh', `${vv.height}px`);
      document.documentElement.style.setProperty('--vvo', `${vv.offsetTop}px`);
    };
    apply();
    vv.addEventListener('resize', apply);
    vv.addEventListener('scroll', apply);
    return () => {
      vv.removeEventListener('resize', apply);
      vv.removeEventListener('scroll', apply);
    };
  }, []);
}

export function Sheet({ title, onClose, children, footer }: { title: string; onClose: () => void; children: ReactNode; footer?: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="sheet-wrap" role="dialog" aria-modal="true" aria-label={title}>
      <button className="sheet-back" aria-label="閉じる" onClick={onClose} />
      <div className="sheet">
        <div className="sheet-head">
          <h2>{title}</h2>
          <button className="round" aria-label="閉じる" onClick={onClose}>
            <Icon name="close" size={20} />
          </button>
        </div>
        <div className="sheet-body">{children}</div>
        {footer && <div className="sheet-foot">{footer}</div>}
      </div>
    </div>
  );
}

// ───────── 料理写真 ─────────

export function Photo({ recipe, className = '' }: { recipe: Recipe; className?: string }) {
  const status = useStore((s) => s.image[recipe.id]);
  const [shown, setShown] = useState(false);
  const tried = useRef(false);
  useEffect(() => {
    // 写真がまだなく、作っている途中でもなければ頼む(開き直したときなど)
    if (!recipe.imageUrl && !status && !tried.current) {
      tried.current = true;
      void loadImage(recipe.id);
    }
  }, [recipe.id, recipe.imageUrl, status]);
  return (
    <div className={`photo ${className} ${recipe.imageUrl ? '' : status === 'capped' || status === 'error' ? 'photo-none' : 'photo-wait'}`}>
      {recipe.imageUrl ? (
        <img src={recipe.imageUrl} alt={recipe.title} className={shown ? 'on' : ''} onLoad={() => setShown(true)} decoding="async" />
      ) : status === 'error' ? (
        <button
          className="photo-retry"
          onClick={(e) => {
            e.stopPropagation();
            void loadImage(recipe.id);
          }}
        >
          <Icon name="redo" size={20} />
          写真をもう一度作る
        </button>
      ) : status === 'capped' ? (
        <span className="photo-note">
          <Icon name="plate" size={28} />
          今月の写真は上限に達しました
        </span>
      ) : (
        <span className="photo-note photo-making">盛り付けています</span>
      )}
    </div>
  );
}

// ───────── お知らせ ─────────

export function Toast() {
  const t = useStore((s) => s.toast);
  if (!t) return null;
  return (
    <div className="toast" role="status" key={t.id}>
      {t.text}
    </div>
  );
}

// ───────── 数を上下する ─────────

export function Stepper({ value, onChange, min, max, label, unit }: { value: number; onChange: (v: number) => void; min: number; max: number; label: string; unit: string }) {
  return (
    <div className="stepper" role="group" aria-label={label}>
      <button className="round" aria-label={`${label}を減らす`} disabled={value <= min} onClick={() => onChange(Math.max(min, value - 1))}>
        <Icon name="minus" size={20} />
      </button>
      <span className="stepper-value">
        <b>{value}</b>
        {unit}
      </span>
      <button className="round" aria-label={`${label}を増やす`} disabled={value >= max} onClick={() => onChange(Math.min(max, value + 1))}>
        <Icon name="plus" size={20} />
      </button>
    </div>
  );
}
