import { build } from 'esbuild';
const common = {
  bundle: true, platform: 'node', target: 'node22', format: 'cjs', sourcemap: true,
  external: ['electron', 'jieba-wasm', 'sql.js'],
  logLevel: 'info',
};
await build({ ...common, entryPoints: ['src/main/main.ts'], outfile: 'dist/main/main.js' });
await build({ ...common, entryPoints: ['src/main/preload.ts'], outfile: 'dist/main/preload.js' });
