// Assemble the deployable site: the product page at /, the editor at /editor/.
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, 'dist');
const web = join(here, '..', 'web');

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
for (const f of ['index.html', 'privacy.html', 'favicon.svg', 'assets']) cpSync(join(here, f), join(out, f), { recursive: true });

execSync('npx vite build --base ./ --outDir ../site/dist/editor --emptyOutDir', { cwd: web, stdio: 'inherit' });
if (!existsSync(join(out, 'editor', 'index.html'))) throw new Error('editor build missing');
console.log('Site ready in', out);
