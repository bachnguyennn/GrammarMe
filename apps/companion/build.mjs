// Bundles the companion into one dependency-free Node script: dist/grammarme-companion.mjs
// (plus dist/grammarme-companion.cjs, the input for the standalone executable)
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

// The same program as CommonJS, the input for the standalone executable (scripts/build-sea.mjs):
// Node's single executable applications run a CommonJS main script.
const cjsFile = join(root, 'dist', 'grammarme-companion.cjs');
await esbuild.build({
  absWorkingDir: root,
  entryPoints: ['src/cli.ts'],
  outfile: cjsFile,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  // import.meta.url only names the bundle file; in the standalone build it is never used for paths.
  define: { 'import.meta.url': '__gmModuleUrl' },
  banner: { js: 'const __gmModuleUrl = require("node:url").pathToFileURL(__filename).href;' },
  legalComments: 'none',
  logLevel: 'warning',
});
console.log(`Built ${cjsFile}`);
