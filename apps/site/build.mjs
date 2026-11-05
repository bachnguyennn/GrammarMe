// Assemble the deployable site: the product page at /, the editor at /editor/,
// and the Chrome extension as a ready-to-load zip at /GrammarMe-extension.zip.
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, 'dist');
const web = join(here, '..', 'web');

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
for (const f of ['index.html', 'privacy.html', 'install.html', 'favicon.svg', 'assets']) cpSync(join(here, f), join(out, f), { recursive: true });

execSync('npx vite build --base ./ --outDir ../site/dist/editor --emptyOutDir', { cwd: web, stdio: 'inherit' });
if (!existsSync(join(out, 'editor', 'index.html'))) throw new Error('editor build missing');

// The extension, zipped around one folder so "Load unpacked" can point straight at it.
const ext = join(here, '..', 'extension');
execSync('node build.mjs', { cwd: ext, stdio: 'inherit' });
const stage = mkdtempSync(join(tmpdir(), 'grammarme-ext-'));
cpSync(join(ext, 'build'), join(stage, 'GrammarMe-extension'), { recursive: true });
execSync(`zip -r -X -q "${join(out, 'GrammarMe-extension.zip')}" GrammarMe-extension`, { cwd: stage, stdio: 'inherit' });
rmSync(stage, { recursive: true, force: true });
console.log('Site ready in', out);
