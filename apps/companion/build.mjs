// Bundles the companion into one dependency-free Node script: dist/grammarme-companion.mjs
//   node build.mjs
import * as esbuild from 'esbuild';
import { chmod } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const outfile = join(root, 'dist', 'grammarme-companion.mjs');

await esbuild.build({
  absWorkingDir: root,
  entryPoints: ['src/cli.ts'],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  banner: { js: '#!/usr/bin/env node' },
  legalComments: 'none',
  logLevel: 'warning',
});
await chmod(outfile, 0o755);
console.log(`Built ${outfile}`);
