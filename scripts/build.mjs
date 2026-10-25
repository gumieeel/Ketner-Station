// Собирает приложение в dist/: главный процесс, preload и страницы интерфейса.
import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const dist = path.join(root, 'dist');
const watchless = { bundle: true, sourcemap: true, logLevel: 'info', legalComments: 'none' };
const minify = process.env.NODE_ENV === 'production';

fs.rmSync(dist, { recursive: true, force: true });

await Promise.all([
  build({ ...watchless, entryPoints: [path.join(root, 'src/main/index.ts')], outfile: path.join(dist, 'main/index.cjs'), platform: 'node', format: 'cjs', target: 'node22', external: ['electron'], minify }),
  build({ ...watchless, entryPoints: [path.join(root, 'src/preload/index.ts')], outfile: path.join(dist, 'preload/index.cjs'), platform: 'node', format: 'cjs', target: 'node22', external: ['electron'], minify }),
  build({ ...watchless, entryPoints: { audio: path.join(root, 'src/renderer/audio/main.ts'), settings: path.join(root, 'src/renderer/settings/main.ts') }, outdir: path.join(dist, 'renderer'), platform: 'browser', format: 'iife', target: 'chrome140', minify }),
]);

for (const file of ['audio/audio.html', 'settings/settings.html', 'settings/settings.css']) {
  fs.copyFileSync(path.join(root, 'src/renderer', file), path.join(dist, 'renderer', path.basename(file)));
}
console.log('Сборка готова: dist/');
