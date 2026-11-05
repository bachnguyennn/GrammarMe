// Builds a loadable unpacked extension into ./build:
//   node build.mjs            production (minified)
//   node build.mjs --dev      unminified + sourcemaps
//   node build.mjs --watch    dev build, rebuilt on change
import * as esbuild from 'esbuild';
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { drawIcon } from './scripts/icons.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const out = join(root, 'build');
const watch = process.argv.includes('--watch');
const dev = watch || process.argv.includes('--dev');

// harper.js's package.json doesn't export its .wasm, so locate the package via its entry point.
const harperDist = dirname(fileURLToPath(import.meta.resolve('harper.js')));

async function copyStatic() {
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const manifest = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8'));
  manifest.version = pkg.version;
  await writeFile(join(out, 'manifest.json'), JSON.stringify(manifest, null, 2));
  await cp(join(root, 'static'), out, { recursive: true });
  // Renamed on purpose — see src/offscreen.ts (avoids harper.js also loading the slim binary).
  await cp(join(harperDist, 'harper_wasm_bg.wasm'), join(out, 'harper.wasm'));
  await mkdir(join(out, 'licenses'), { recursive: true });
  await cp(join(harperDist, '..', 'LICENSE'), join(out, 'licenses', 'harper.js-LICENSE.txt'));
  await mkdir(join(out, 'icons'), { recursive: true });
  for (const size of [16, 32, 48, 128]) await writeFile(join(out, 'icons', `icon-${size}.png`), drawIcon(size));
}

/** @type {esbuild.BuildOptions} */
const options = {
  absWorkingDir: root,
  entryPoints: {
    background: 'src/background.ts',
    offscreen: 'src/offscreen.ts',
    content: 'src/content.ts',
    popup: 'src/popup.ts',
  },
  outdir: out,
  bundle: true,
  format: 'iife', // content scripts can't be modules; keep every entry a plain script
  platform: 'browser',
  target: 'chrome116',
  minify: !dev,
  sourcemap: dev ? 'linked' : false,
  legalComments: 'eof',
  // harper.js has a Node-only `import("fs")` path guarded by `typeof process`; never taken here.
  external: ['fs'],
  logLevel: watch ? 'info' : 'warning',
};

async function dirSize(dir) {
  let total = 0;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    total += entry.isDirectory() ? await dirSize(p) : (await stat(p)).size;
  }
  return total;
}

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
await copyStatic();

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
  console.log('Watching src/ … (static files are copied once; re-run on manifest/static changes)');
} else {
  const result = await esbuild.build({ ...options, metafile: true });
  for (const [file, info] of Object.entries(result.metafile.outputs)) {
    if (file.endsWith('.js')) console.log(`  ${file.replace(/^.*build\//, 'build/')}  ${(info.bytes / 1024).toFixed(1)} KB`);
  }
  console.log(`build/ total: ${((await dirSize(out)) / 1024 / 1024).toFixed(2)} MB`);
}
