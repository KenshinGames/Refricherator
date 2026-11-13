import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// 画面のもとは app/ にあり、公開用に作ったものはリポジトリの直下(index.html と assets/)に出す。
// GitHub Pages が「main の直下」を公開する設定になっているため。
export default defineConfig({
  root: 'app',
  base: './',
  plugins: [react()],
  build: { outDir: '..', emptyOutDir: false, assetsDir: 'assets' },
  server: { port: 5273, strictPort: true, host: true, fs: { allow: ['..'] } },
  test: { root: '.', include: ['tests/**/*.test.ts'], environment: 'node' },
});
