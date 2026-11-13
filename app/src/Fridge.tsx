// 冷蔵庫の画面:食材を足す4つの方法と、今あるものの一覧。
import { useEffect, useMemo, useRef, useState } from 'react';
import { normName } from '../../supabase/functions/api/core.ts';
import { lookup, quickParse, quickPicks } from './foods.ts';
import { addItems, ApiError, daysLeft, parse, removeItems, restoreItems, setDays, toast, useStore } from './store.ts';
import type { Item, NewItem } from './store.ts';
import { Icon, leftLabel, leftTone, Ring, Sheet, Stepper } from './ui.tsx';

type AddMode = 'text' | 'picks' | 'receipt' | 'photo';

/** 写真を送りやすい大きさの JPEG にする(長い辺 1400px まで) */
async function toJpeg(file: File): Promise<{ data: string; mime: string; preview: string }> {
  const bitmap = await createImageBitmap(file).catch(() => null);
  if (!bitmap) {
    // 縮められない形式は、そのまま送る
    const raw = await new Promise<string>((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(String(fr.result));
      fr.onerror = () => reject(new Error('read'));
      fr.readAsDataURL(file);
    });
    return { data: raw.slice(raw.indexOf(',') + 1), mime: file.type || 'image/jpeg', preview: raw };
  }
  const scale = Math.min(1, 1400 / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  const url = canvas.toDataURL('image/jpeg', 0.82);
  return { data: url.slice(url.indexOf(',') + 1), mime: 'image/jpeg', preview: url };
}

export function Fridge() {
  const items = useStore((s) => s.items);
  const [mode, setMode] = useState<AddMode | null>(null);
  const [shot, setShot] = useState<{ file: File; kind: 'receipt' | 'photo' } | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const receiptInput = useRef<HTMLInputElement>(null);
  const photoInput = useRef<HTMLInputElement>(null);

  const groups = useMemo(() => {
    const soon: Item[] = [];
    const week: Item[] = [];
    const later: Item[] = [];
    for (const i of items) {
      const d = daysLeft(i);
      (d <= 2 ? soon : d <= 7 ? week : later).push(i);
    }
    return [
      { title: 'そろそろ使い切りたい', list: soon },
      { title: '今週のうちに', list: week },
      { title: 'まだ大丈夫', list: later },
    ].filter((g) => g.list.length);
  }, [items]);

  const pick = (kind: 'receipt' | 'photo') => (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setShot({ file, kind });
    setMode(kind);
  };
  const editingItem = items.find((i) => i.id === editing);

  return (
    <div className="screen">
      <header className="title-row">
        <h1>冷蔵庫</h1>
        {items.length > 0 && <span className="count">{items.length}品</span>}
      </header>

      <div className="add-panel" aria-label="食材を足す">
        <button onClick={() => receiptInput.current?.click()}>
          <Icon name="receipt" />
          レシート
        </button>
        <button onClick={() => photoInput.current?.click()}>
          <Icon name="camera" />
          写真
        </button>
        <button onClick={() => setMode('text')}>
          <Icon name="mic" />
          話す・打つ
        </button>
        <button onClick={() => setMode('picks')}>
          <Icon name="star" />
          いつもの
        </button>
      </div>
      <input ref={receiptInput} type="file" accept="image/*" capture="environment" hidden onChange={pick('receipt')} data-testid="receipt-input" />
      <input ref={photoInput} type="file" accept="image/*" capture="environment" hidden onChange={pick('photo')} data-testid="photo-input" />

      {items.length === 0 ? (
        <div className="empty">
          <p className="empty-title">冷蔵庫は空です</p>
          <p>買ってきたものを、上の4つのどれかで入れてください。レシートを撮るのがいちばん早く済みます。</p>
        </div>
      ) : (
        groups.map((g) => (
          <section key={g.title} className="group">
            <h2>{g.title}</h2>
            <ul className="rows">
              {g.list.map((i) => (
                <li key={i.id}>
                  <button className="row" onClick={() => setEditing(i.id)}>
                    <Ring item={i} />
                    <span className="row-main">
                      <span className="row-name">{i.name}</span>
                      <span className={`left left-${leftTone(daysLeft(i))}`}>{leftLabel(daysLeft(i))}</span>
                    </span>
                    <Icon name="right" size={18} />
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ))
      )}

      {mode && (
        <AddSheet
          mode={mode}
          shot={shot}
          onClose={() => {
            setMode(null);
            setShot(null);
          }}
          onRetake={() => (mode === 'receipt' ? receiptInput : photoInput).current?.click()}
        />
      )}
      {editingItem && <ItemSheet item={editingItem} onClose={() => setEditing(null)} />}
    </div>
  );
}

// ───────── 足す ─────────

const TITLES: Record<AddMode, string> = { text: '話す・打つ', picks: 'いつもの', receipt: 'レシートから', photo: '写真から' };

function AddSheet({ mode, shot, onClose, onRetake }: { mode: AddMode; shot: { file: File; kind: 'receipt' | 'photo' } | null; onClose: () => void; onRetake: () => void }) {
  const staples = useStore((s) => s.staples);
  const items = useStore((s) => s.items);
  const have = useMemo(() => new Set(items.map((i) => normName(i.name))), [items]);
  const [held, setHeld] = useState<NewItem[]>([]); // 写真に写っていたが、もう冷蔵庫にあるもの
  const [phase, setPhase] = useState<'input' | 'reading' | 'confirm' | 'error'>(mode === 'receipt' || mode === 'photo' ? 'reading' : 'input');
  const [text, setText] = useState('');
  const [found, setFound] = useState<NewItem[]>([]);
  const [preview, setPreview] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [added, setAdded] = useState<string[]>([]);
  const run = useRef(0);

  // 写真が渡されたら、すぐ読み取りを始める
  useEffect(() => {
    if (!shot) return;
    const id = ++run.current;
    setPhase('reading');
    setPreview(null);
    (async () => {
      try {
        const img = await toJpeg(shot.file);
        if (id !== run.current) return;
        setPreview(img.preview);
        const read = await parse({ image: { data: img.data, mime: img.mime }, kind: shot.kind });
        if (id !== run.current) return;
        // 冷蔵庫の中を撮ったときは、もう入っているものまで二重に入らないよう外しておく
        const dup = shot.kind === 'photo' ? read.filter((r) => have.has(normName(r.name))) : [];
        setHeld(dup);
        setFound(read.filter((r) => !dup.includes(r)));
        setPhase('confirm');
      } catch (e) {
        if (id !== run.current) return;
        setError(e instanceof ApiError ? e.message : '写真を読み取れませんでした。もう一度撮ってみてください。');
        setPhase('error');
      }
    })();
    return () => {
      run.current++;
    };
  }, [shot]);

  const readText = async () => {
    const value = text.trim();
    if (!value) return;
    // 食材名だけが並んでいて、どれも知っているものなら、AI を呼ばずにすぐ出す
    const quick = quickParse(value, staples);
    if (quick) {
      setFound(quick);
      setPhase('confirm');
      return;
    }
    const id = ++run.current;
    setPhase('reading');
    try {
      const items = await parse({ text: value });
      if (id !== run.current) return;
      setFound(items);
      setPhase('confirm');
    } catch (e) {
      if (id !== run.current) return;
      setError(e instanceof ApiError ? e.message : 'うまく読み取れませんでした。もう一度お試しください。');
      setPhase('error');
    }
  };

  const commit = () => {
    addItems(found);
    toast(`${found.length}品を冷蔵庫に入れました`);
    onClose();
  };

  if (mode === 'picks') {
    const picks = quickPicks(staples);
    return (
      <Sheet title="いつもの" onClose={onClose} footer={<button className="btn" onClick={onClose}>{added.length ? `${added.length}品を入れました。閉じる` : '閉じる'}</button>}>
        <p className="hint">押すとすぐ冷蔵庫に入ります。よく買うものが、だんだんここに並びます。</p>
        <div className="picks">
          {picks.map((p) => {
            const n = added.filter((a) => a === p.name).length;
            return (
              <button
                key={p.name}
                className={`pick ${n ? 'pick-on' : ''}`}
                onClick={() => {
                  addItems([p]);
                  setAdded((a) => [...a, p.name]);
                }}
              >
                {n > 0 && <Icon name="check" size={16} />}
                {p.name}
                {n > 1 && <span className="pick-n">×{n}</span>}
              </button>
            );
          })}
        </div>
      </Sheet>
    );
  }

  if (phase === 'input') {
    return (
      <Sheet
        title={TITLES[mode]}
        onClose={onClose}
        footer={
          <button className="btn" disabled={!text.trim()} onClick={readText}>
            読み取る
          </button>
        }
      >
        <textarea
          className="field"
          autoFocus
          rows={3}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="卵と牛乳、あと豚こま買った"
          aria-label="買ってきたもの"
        />
        <p className="hint">ふだんの言葉のままで大丈夫です。キーボードのマイクで話しても入ります。</p>
      </Sheet>
    );
  }

  if (phase === 'reading') {
    return (
      <Sheet title={TITLES[mode]} onClose={onClose}>
        {preview && <img className="shot" src={preview} alt="撮った写真" />}
        <div className="reading" role="status">
          <span className="pulse" />
          読み取っています
        </div>
        <ul className="rows" aria-hidden="true">
          {[72, 54, 64].map((w) => (
            <li key={w} className="row row-skel">
              <span className="skel" style={{ width: `${w}%` }} />
            </li>
          ))}
        </ul>
      </Sheet>
    );
  }

  if (phase === 'error') {
    return (
      <Sheet
        title={TITLES[mode]}
        onClose={onClose}
        footer={
          mode === 'text' ? (
            <button className="btn" onClick={() => setPhase('input')}>
              書き直す
            </button>
          ) : (
            <button className="btn" onClick={onRetake}>
              もう一度撮る
            </button>
          )
        }
      >
        <p className="problem">{error}</p>
      </Sheet>
    );
  }

  // 確認
  return (
    <Sheet
      title={found.length ? `${found.length}品を見つけました` : held.length ? '新しいものはありません' : '見つかりませんでした'}
      onClose={onClose}
      footer={
        found.length ? (
          <button className="btn" onClick={commit}>
            {found.length}品を冷蔵庫に入れる
          </button>
        ) : mode === 'text' ? (
          <button className="btn" onClick={() => setPhase('input')}>
            書き直す
          </button>
        ) : (
          <button className="btn" onClick={onRetake}>
            もう一度撮る
          </button>
        )
      }
    >
      {held.length > 0 && (
        <p className="held">
          もう冷蔵庫にある{held.length}品({held.map((h) => h.name).join('・')})は外しました。
          <button
            onClick={() => {
              setFound((l) => [...l, ...held]);
              setHeld([]);
            }}
          >
            それも入れる
          </button>
        </p>
      )}
      {found.length === 0 && held.length > 0 ? null : found.length === 0 ? (
        <p className="problem">食材を読み取れませんでした。{mode === 'text' ? '食材の名前を入れてみてください。' : '明るいところで、全体が入るように撮ってみてください。'}</p>
      ) : (
        <>
          <p className="hint">ちがうものは × で外せます。</p>
          <ul className="rows">
            {found.map((f, idx) => (
              <li key={`${f.name}-${idx}`} className="row row-edit">
                <span className="row-name">
                  {f.name}
                  {have.has(normName(f.name)) && <small className="dup">もうあります</small>}
                </span>
                <span className="mini-step">
                  <button aria-label={`${f.name}の日数を減らす`} disabled={f.days <= 1} onClick={() => setFound((l) => l.map((x, i) => (i === idx ? { ...x, days: Math.max(1, x.days - 1) } : x)))}>
                    <Icon name="minus" size={16} />
                  </button>
                  <span className="mini-value">
                    <b>{f.days}</b>日
                  </span>
                  <button aria-label={`${f.name}の日数を増やす`} onClick={() => setFound((l) => l.map((x, i) => (i === idx ? { ...x, days: Math.min(365, x.days + 1) } : x)))}>
                    <Icon name="plus" size={16} />
                  </button>
                </span>
                <button className="row-x" aria-label={`${f.name}を外す`} onClick={() => setFound((l) => l.filter((_, i) => i !== idx))}>
                  <Icon name="close" size={18} />
                </button>
              </li>
            ))}
          </ul>
          <AddOne
            onAdd={(name) => {
              if (found.some((f) => f.name === name)) return;
              setFound((l) => [...l, lookup(name, staples) ?? { name, category: 'その他', days: 5 }]);
            }}
          />
        </>
      )}
    </Sheet>
  );
}

/** 読み取りからもれたものを、1つ足す */
function AddOne({ onAdd }: { onAdd: (name: string) => void }) {
  const [name, setName] = useState('');
  const submit = () => {
    const v = name.trim().slice(0, 30);
    if (!v) return;
    onAdd(v);
    setName('');
  };
  return (
    <form
      className="add-one"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <input className="field" value={name} onChange={(e) => setName(e.target.value)} placeholder="もれたものを足す" aria-label="もれたものを足す" enterKeyHint="done" />
      <button type="submit" className="round" aria-label="足す" disabled={!name.trim()}>
        <Icon name="plus" size={20} />
      </button>
    </form>
  );
}

// ───────── 1つを直す ─────────

function ItemSheet({ item, onClose }: { item: Item; onClose: () => void }) {
  const days = Math.max(0, daysLeft(item));
  const quick: [string, number][] = [
    ['今日まで', 0],
    ['あと3日', 3],
    ['1週間', 7],
    ['2週間', 14],
  ];
  return (
    <Sheet
      title={item.name}
      onClose={onClose}
      footer={
        <button
          className="btn btn-line"
          onClick={() => {
            removeItems([item.id]);
            toast(`${item.name}を出しました`, { label: '元に戻す', run: () => restoreItems([item]) });
            onClose();
          }}
        >
          もうない(使い切った・捨てた)
        </button>
      }
    >
      <p className="hint">おいしく食べられる日数の目安です。</p>
      <Stepper value={days} min={0} max={365} label="残りの日数" unit="日" onChange={(v) => setDays(item.id, v)} />
      <div className="picks picks-center">
        {quick.map(([label, d]) => (
          <button key={label} className={`pick ${days === d ? 'pick-on' : ''}`} onClick={() => setDays(item.id, d)}>
            {label}
          </button>
        ))}
      </div>
    </Sheet>
  );
}
