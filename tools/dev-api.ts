// 手元で動かす中継サーバー。本番と同じ core を、メモリ上の保存先で動かす。
//   node tools/dev-api.ts          にせものの AI(お金はかからない)
//   node tools/dev-api.ts --real   本物の Gemini(GEMINI_API_KEY を使う)
import { createServer } from 'node:http';
import { AppError, handle, passOk, sha256 } from '../supabase/functions/api/core.ts';
import { makeGemini, prompts } from '../supabase/functions/api/gemini.ts';
import { makeFakeAI, makeMemoryStore } from './memory.ts';

const real = process.argv.includes('--real');
const port = Number(process.env.API_PORT ?? 8791);
const pass = process.env.DEV_PASSCODE ?? 'test-pass';
const passHash = await sha256(pass);
let store = makeMemoryStore();
const state = { delay: Number(process.env.FAKE_DELAY ?? 700), fail: false };
const ai = real
  ? makeGemini({ key: process.env.GEMINI_API_KEY ?? '' })
  : makeFakeAI({ get delay() { return state.delay; }, fail: () => state.fail });

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type, x-passcode',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

createServer(async (req, res) => {
  const send = (status: number, body: unknown) => {
    res.writeHead(status, { ...CORS, 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(body));
  };
  if (req.method === 'OPTIONS') return send(204, {});
  let raw = '';
  for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw || '{}');
  // テスト用:保存先を空にする、AI の遅さや失敗を切り替える
  if (req.url === '/__test') {
    if (body.reset) store = makeMemoryStore();
    if (typeof body.delay === 'number') state.delay = body.delay;
    if (typeof body.fail === 'boolean') state.fail = body.fail;
    return send(200, { ok: true });
  }
  try {
    if (!(await passOk(String(req.headers['x-passcode'] ?? ''), passHash))) {
      return send(401, { error: { code: 'passcode', message: '合言葉が違います。' } });
    }
    if (body.action === 'ping') return send(200, { ok: true, ai: true });
    send(200, await handle(body.action, body, { store, ai, prompts }));
  } catch (e) {
    if (e instanceof AppError) return send(e.status, { error: { code: e.code, message: e.message } });
    console.error(e);
    send(500, { error: { code: 'server', message: 'うまくいきませんでした。もう一度お試しください。' } });
  }
}).listen(port, () => console.log(`dev api: http://localhost:${port}  (${real ? '本物の Gemini' : 'にせものの AI'} / 合言葉 ${pass})`));
