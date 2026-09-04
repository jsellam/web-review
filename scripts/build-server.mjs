import { build } from 'esbuild';

await build({
  entryPoints: ['src/server/cli.ts'],
  outfile: 'dist/web-review.mjs',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node18',
  minify: false,
  sourcemap: false,
  banner: { js: '#!/usr/bin/env node' },
});

console.log('built dist/web-review.mjs');
