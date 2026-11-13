// icon.svg から、ホーム画面用の PNG を作る
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
const svg = readFileSync(new URL('../app/public/icon.svg', import.meta.url), 'utf8');
const browser = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
const page = await browser.newPage();
for (const [name, size] of [['icon-192.png', 192], ['icon-512.png', 512], ['apple-touch-icon.png', 180]]) {
  await page.setViewport({ width: size, height: size, deviceScaleFactor: 1 });
  await page.setContent(`<style>html,body{margin:0}svg{display:block;width:${size}px;height:${size}px}</style>${svg}`);
  await page.screenshot({ path: fileURLToPath(new URL(`../app/public/${name}`, import.meta.url)), type: 'png' });
}
await browser.close();
console.log('icons ok');
