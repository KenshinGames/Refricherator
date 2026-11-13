// Gemini の呼び出しと、指示文。
import { AppError, CATEGORIES, PANTRY } from './core.ts';
import type { AI, Part, Prompts, Recipe, Scene, SuggestInput } from './core.ts';

const BASE = 'https://generativelanguage.googleapis.com/v1beta/models/';

export interface GeminiOptions {
  key: string;
  textModel?: string;
  imageModel?: string;
  fetchImpl?: typeof fetch;
}

export function makeGemini(opt: GeminiOptions): AI {
  const f = opt.fetchImpl ?? fetch;
  const textModel = opt.textModel || 'gemini-3.5-flash-lite';
  const imageModel = opt.imageModel || 'gemini-3.1-flash-lite-image';

  async function call(model: string, body: unknown): Promise<Record<string, any>> {
    let last = '';
    for (let attempt = 0; attempt < 2; attempt++) {
      let res: Response;
      try {
        res = await f(`${BASE}${model}:generateContent`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-goog-api-key': opt.key },
          body: JSON.stringify(body),
        });
      } catch (e) {
        last = String(e);
        continue;
      }
      if (res.ok) return await res.json();
      last = `${res.status} ${(await res.text()).slice(0, 300)}`;
      // 混雑や一時的な失敗だけ、もう一度だけ試す
      if (![429, 500, 502, 503, 504].includes(res.status)) break;
    }
    console.error('gemini error', model, last);
    throw new AppError('ai', 'AI が混み合っているようです。少し待ってもう一度お試しください。', 502);
  }

  return {
    async json(parts: Part[], schema: unknown) {
      const j = await call(textModel, {
        contents: [{ parts }],
        generationConfig: { responseMimeType: 'application/json', responseSchema: schema, temperature: 0.9 },
      });
      const text: string = (j.candidates?.[0]?.content?.parts ?? []).map((p: any) => p.text ?? '').join('');
      try {
        return JSON.parse(text);
      } catch {
        console.error('gemini json parse failed', text.slice(0, 200));
        throw new AppError('ai', 'AI の返事をうまく読めませんでした。もう一度お試しください。', 502);
      }
    },
    async image(prompt: string) {
      const j = await call(imageModel, {
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { responseModalities: ['IMAGE'], imageConfig: { aspectRatio: '4:3' } },
      });
      const part = (j.candidates?.[0]?.content?.parts ?? []).find((p: any) => p.inlineData?.data);
      if (!part) throw new AppError('ai', '写真を作れませんでした。', 502);
      const bin = atob(part.inlineData.data);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return { bytes, mime: part.inlineData.mimeType || 'image/jpeg' };
    },
  };
}

// ───────── 応答の形 ─────────

const itemsSchema = {
  type: 'OBJECT',
  properties: {
    items: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          name: { type: 'STRING' },
          category: { type: 'STRING', enum: [...CATEGORIES] },
          days: { type: 'INTEGER' },
        },
        required: ['name', 'category', 'days'],
      },
    },
  },
  required: ['items'],
};

const dishesSchema = {
  type: 'OBJECT',
  properties: {
    dishes: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          title: { type: 'STRING' },
          lead: { type: 'STRING' },
          minutes: { type: 'INTEGER' },
          ingredients: {
            type: 'ARRAY',
            items: {
              type: 'OBJECT',
              properties: {
                name: { type: 'STRING' },
                amount: { type: 'STRING' },
                source: { type: 'STRING', enum: ['fridge', 'pantry', 'buy'] },
              },
              required: ['name', 'amount', 'source'],
            },
          },
          steps: { type: 'ARRAY', items: { type: 'STRING' } },
          tip: { type: 'STRING' },
        },
        required: ['title', 'lead', 'minutes', 'ingredients', 'steps', 'tip'],
      },
    },
  },
  required: ['dishes'],
};

const ideasSchema = {
  type: 'OBJECT',
  properties: {
    ideas: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          buy: { type: 'STRING' },
          dish: { type: 'STRING' },
          uses: { type: 'ARRAY', items: { type: 'STRING' } },
          minutes: { type: 'INTEGER' },
        },
        required: ['buy', 'dish', 'uses', 'minutes'],
      },
    },
  },
  required: ['ideas'],
};

// ───────── 指示文 ─────────

const ITEM_RULES = `出力のきまり:
- name は家庭で呼ぶ短い食材名(例:「豚こま肉」「小松菜」「絹豆腐」「牛乳」)。商品名・メーカー名・容量・値段は入れない
- 同じ食材は1つにまとめる
- 食べ物・飲み物でないもの(洗剤、袋、ポイント、割引など)は入れない
- 塩・醤油・油・砂糖などの基本の調味料と米は入れない
- category は ${CATEGORIES.join(' / ')} のどれか
- days は、今日買って冷蔵庫(冷凍品は冷凍庫)に入れたときに、おいしく食べられる日数の目安(整数)。例:ひき肉2、豚こま肉3、鶏肉2、刺身1、鮭の切り身2、もやし2、葉物野菜4、きのこ5、トマト6、絹豆腐5、牛乳7、ヨーグルト10、卵14、納豆7、ハム7、キャベツ10、にんじん14、玉ねぎ30、じゃがいも30、冷凍食品60
- 食材が1つも見つからなければ items は空の配列`;

const SCENE_TEXT: Record<Scene, string> = {
  tired: `場面:仕事終わりで疲れている平日の夜。
- 15分以内で作れる。工程は4つまで。洗い物が少ない(フライパン1つ、レンジ、鍋1つなど)
- 包丁をあまり使わない、失敗しにくい料理
- 1品目と2品目は、冷蔵庫にあるものと調味料だけで作る(buy を含めない)。3品目だけ、1つまで買い足してよい`,
  holiday: `場面:休みの日。少し気合いを入れて、作る時間も楽しみたい。
- 30〜90分かけてよい。ひと手間かけた、食卓が華やぐ料理
- 家にあるものを主役にする。1品目は、冷蔵庫にあるものと調味料だけで作る(buy を含めない)。2品目と3品目は、2つまで買い足してよい`,
  bento: `場面:平日のお弁当用のおかずを、前の晩か朝に作る。
- 冷めてもおいしい。汁気が少ない。弁当箱に詰めやすい
- 20分以内。3品は味や色がかぶらないようにする(主菜1〜2、副菜1〜2)
- 1品目と2品目は、冷蔵庫にあるものと調味料だけで作る(buy を含めない)。3品目だけ、1つまで買い足してよい`,
};

function fridgeText(items: SuggestInput['items']): string {
  if (!items.length) return '(冷蔵庫は空)';
  return items
    .map((i) => `- ${i.name}(${i.daysLeft < 0 ? '期限の目安を過ぎている' : i.daysLeft === 0 ? '今日まで' : `あと${i.daysLeft}日`})`)
    .join('\n');
}

export const prompts: Prompts = {
  parseText(text) {
    return {
      parts: [
        {
          text: `次の文章は、買ってきた・家にある食材について書かれたメモ(音声入力のこともある)です。食材を抜き出してください。\n${ITEM_RULES}\n\nメモ:\n「${text}」`,
        },
      ],
      schema: itemsSchema,
    };
  },

  parseImage(image, kind) {
    const lead =
      kind === 'receipt'
        ? 'この写真はスーパーなどのレシートです。買った食材を抜き出してください。略された商品名は、ふつうの食材名に直してください(例:「コクサンブタコマ」→「豚こま肉」)。'
        : 'この写真には、買ってきた食材や冷蔵庫の中が写っています。はっきり見える食材を抜き出してください。見えないものを推測で足さないでください。';
    return {
      parts: [{ text: `${lead}\n${ITEM_RULES}` }, { inlineData: { mimeType: image.mime, data: image.data } }],
      schema: itemsSchema,
    };
  },

  suggest({ scene, items, settings, avoid, dish, buy }) {
    const common = `あなたは家庭料理の先生です。冷蔵庫の食材を、おいしく使い切るための料理を考えます。

冷蔵庫にあるもの(期限の近い順):
${fridgeText(items)}

いつも家にある調味料など:${PANTRY.join('、')}

${SCENE_TEXT[scene]}

きまり:
- ${settings.servings}人分
- 期限の近い食材から優先して使う。「今日まで」「あと1〜2日」のものは、できるだけどれかの料理に入れる
- 夕食やお弁当のおかずになる料理にする(デザートや飲み物は出さない)
- 家庭のコンロ・電子レンジ・ふつうの道具で作れる。生焼けになりやすい肉や魚は、火の通し方を手順に書く
${settings.dislikes ? `- 次のものは使わない:${settings.dislikes}\n` : ''}- ingredients には使うものをすべて書く。name は、冷蔵庫にあるものは上の一覧と同じ名前で書く
- source は、冷蔵庫の一覧にあるものが fridge、いつも家にある調味料などが pantry、買い足すものが buy
- amount は「120g」「1/2束」「大さじ1」のように書く
- title は料理名だけ(20文字まで)。lead はその料理の魅力をひとこと(30文字まで、「〜です」などは付けない)
- steps は1つずつ短く、だれでも分かる言葉で。火加減と時間の目安を入れる
- tip はおいしく作るコツをひとこと(40文字まで)`;

    const ask = dish
      ? `\n\n「${dish}」のレシピを1品だけ作ってください。${buy ? `「${buy}」は買い足す前提です(source は buy)。` : ''}冷蔵庫にあるものをできるだけ使ってください。`
      : `\n\n3品を提案してください。
- 買い足し(buy)のきまりは、上の「場面」に書いたとおりに守る
- 3品は、主に使う食材や味つけが互いにかぶらないようにする
${avoid.length ? `- 最近出した次の料理とは違うものにする:${avoid.join('、')}` : ''}`;

    return { parts: [{ text: common + ask }], schema: dishesSchema };
  },

  shopping({ items, settings }) {
    return {
      parts: [
        {
          text: `スーパーで買い物をしています。家の冷蔵庫にあるものに「あと1つ」買い足すと作れる、今夜の夕食のおかずを4つ考えてください。

冷蔵庫にあるもの(期限の近い順):
${fridgeText(items)}

いつも家にある調味料など:${PANTRY.join('、')}

きまり:
- buy は買い足す食材を1つだけ(スーパーで買える、ふつうの食材名)。4つとも違う食材にする
- dish は料理名(20文字まで)。${settings.servings}人分を想定
- uses は、その料理で使う冷蔵庫の食材(上の一覧と同じ名前で、1〜3つ)。期限の近いものを優先する
- minutes は作る時間の目安
${settings.dislikes ? `- 次のものは使わない:${settings.dislikes}` : ''}`,
        },
      ],
      schema: ideasSchema,
    };
  },

  image(recipe: Recipe) {
    const main = recipe.ingredients
      .filter((i) => i.source !== 'pantry')
      .map((i) => i.name)
      .join('、');
    const plate =
      recipe.scene === 'bento'
        ? 'シンプルな木の弁当箱にきれいに詰めてある。'
        : '上質な陶器の皿に、家庭料理らしく自然に盛り付けてある。';
    return `料理雑誌に載るような、おいしそうな料理の写真。料理は「${recipe.title}」。${plate}
使っている食材は ${main} だけ。それ以外の具材は入れない。
やわらかい自然光、斜め上からの構図、背景は明るい色の木のテーブル、背景は少しぼかす。
文字、ロゴ、人物、手は入れない。`;
  },
};
