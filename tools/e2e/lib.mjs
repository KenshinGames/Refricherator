// 画面の自動テストの道具。先に `npm run api` と `npm run dev` を動かしておく。
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

export const BASE = process.env.E2E_BASE ?? 'http://localhost:5273/';
export const API = process.env.E2E_API ?? 'http://localhost:8791';
export const OUT = fileURLToPath(new URL('../../.e2e-out/', import.meta.url));
mkdirSync(OUT, { recursive: true });
export const SIZES = { se1: [320, 568], se: [375, 667], iphone: [390, 844], max: [430, 932] };
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function apiTest(body) {
  await fetch(API + '/__test', { method: 'POST', body: JSON.stringify(body) });
}
export async function apiCall(action, body = {}) {
  const r = await fetch(API + '/functions/v1/api', { method: 'POST', headers: { 'content-type': 'application/json', 'x-passcode': 'test-pass' }, body: JSON.stringify({ action, ...body }) });
  return r.json();
}

export async function launch() {
  return puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true, args: ['--hide-scrollbars'] });
}

/** 新しいページ(スマホの大きさ・タッチ)。pass を渡すと合言葉入りのリンクで開く */
export async function openPage(browser, { size = 'iphone', pass = 'test-pass', path = '' } = {}) {
  const [width, height] = SIZES[size];
  // サイズごとに、まっさらな状態(保存したものが残っていない)で開く
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  await page.setViewport({ width, height, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  // E2E_DARK=1 のときは、ダークモードで確かめる(写しの名前に -dark が付く)
  const dark = process.env.E2E_DARK === '1';
  if (dark) await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && !/Failed to load resource/.test(m.text()) && errors.push(m.text()));
  await page.goto(BASE + (pass ? `#k=${pass}` : '') , { waitUntil: 'networkidle0' });
  if (path) await page.evaluate((p) => { location.hash = p; window.dispatchEvent(new PopStateEvent('popstate')); }, path);
  const h = {
    page,
    errors,
    size,
    shot: (name) => page.screenshot({ path: `${OUT}${name}-${size}${dark ? '-dark' : ''}.png` }),
    /** 見えている文字で押す(ボタン・リンク) */
    async tap(text, { exact = false } = {}) {
      const ok = await page.evaluate(({ text, exact }) => {
        const els = [...document.querySelectorAll('button, a')].filter((e) => {
          const r = e.getBoundingClientRect();
          if (!r.width || !r.height) return false;
          const t = (e.textContent ?? '').trim();
          const label = e.getAttribute('aria-label') ?? '';
          return exact ? t === text || label === text : t.includes(text) || label === text;
        });
        // シートが出ているときは、シートの中を優先する
        const el = els.find((e) => e.closest('.sheet')) ?? els[0];
        if (!el) return false;
        el.click();
        return true;
      }, { text, exact });
      if (!ok) throw new Error(`押すものが見つからない: ${text}`);
    },
    async waitText(text, timeout = 8000) {
      await page.waitForFunction((t) => document.querySelector('.app')?.innerText.includes(t), { timeout }, text);
    },
    async waitGone(selector, timeout = 8000) {
      await page.waitForFunction((s) => !document.querySelector(s), { timeout }, selector);
    },
    text: () => page.evaluate(() => document.querySelector('.app').innerText),
    /** 表示が切れていないかを調べる。問題のある要素の一覧を返す */
    layout: () => page.evaluate(() => {
      const vw = document.documentElement.clientWidth;
      const vh = window.innerHeight;
      const bad = [];
      const name = (el) => `${el.tagName.toLowerCase()}.${String(el.className?.baseVal ?? el.className).split(' ').join('.')} 「${(el.textContent ?? '').trim().slice(0, 16)}」`;
      for (const el of document.querySelectorAll('.app *')) {
        if (el.closest('.door-open')) continue; // 開く途中の扉は画面の外へ出ていく
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue;
        const cs = getComputedStyle(el);
        if (cs.visibility === 'hidden' || cs.display === 'none') continue;
        // 横にはみ出している
        if (r.right > vw + 0.5 || r.left < -0.5) bad.push(`横にはみ出し ${Math.round(r.left)}〜${Math.round(r.right)}/${vw}: ${name(el)}`);
        // 中身が箱に収まらず切れている(スクロールできる箱と、わざと隠す写真の枠は除く)
        const scrollable = ['auto', 'scroll'].includes(cs.overflowY) || ['auto', 'scroll'].includes(cs.overflowX);
        if (!scrollable && !el.classList.contains('photo') && el.tagName !== 'svg' && !el.closest('svg') && el.tagName !== 'TEXTAREA' && el.tagName !== 'INPUT') {
          if (el.scrollWidth > el.clientWidth + 1 && cs.overflowX !== 'visible') bad.push(`横に切れている ${el.scrollWidth}>${el.clientWidth}: ${name(el)}`);
          if (el.scrollHeight > el.clientHeight + 1 && cs.overflowY !== 'visible' && el.clientHeight > 0) bad.push(`縦に切れている ${el.scrollHeight}>${el.clientHeight}: ${name(el)}`);
        }
        // 文字が親のボタンからはみ出している
        if (el.matches('button, .stamp, .tag, .pick') && el.children.length === 0) {
          const range = document.createRange();
          range.selectNodeContents(el);
          const tr = range.getBoundingClientRect();
          if (tr.width && (tr.right > r.right + 1 || tr.left < r.left - 1 || tr.bottom > r.bottom + 1 || tr.top < r.top - 1)) bad.push(`文字が枠からはみ出し: ${name(el)}`);
        }
      }
      // 画面の下に固定したものが、画面の外に出ていないか
      for (const el of document.querySelectorAll('.tabs, .sheet-foot, .dock')) {
        const r = el.getBoundingClientRect();
        if (r.bottom > vh + 0.5) bad.push(`下にはみ出し ${Math.round(r.bottom)}/${vh}: ${name(el)}`);
      }
      // 押せるものが小さすぎないか(44px 未満)
      for (const el of document.querySelectorAll('.app button, .app a')) {
        const r = el.getBoundingClientRect();
        if (!r.width || el.closest('.door-open') || el.classList.contains('sheet-back')) continue;
        if (r.height < 40 || r.width < 40) bad.push(`押しにくい ${Math.round(r.width)}x${Math.round(r.height)}: ${name(el)}`);
      }
      return [...new Set(bad)];
    }),
  };
  return h;
}
