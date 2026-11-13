// 前回の公開用ファイル(assets/)を消してから作り直す
import { rmSync } from 'node:fs';
rmSync(new URL('../assets', import.meta.url), { recursive: true, force: true });
