// Screenshots of the REAL editor and extension for the product site, so the site never shows a
// feature that doesn't exist. Run after `npm run build:site` (it serves apps/site/dist and loads
// apps/extension/build):
//
//   node apps/site/scripts/shots.mjs
//
// Writes WebP files to apps/site/assets/shots/. Uses your installed Chrome (CHROME_PATH to override)
// in headless mode with a throwaway profile.
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, '..', 'dist');
const extDir = join(here, '..', '..', 'extension', 'build');
const out = join(here, '..', 'assets', 'shots');
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
if (!existsSync(join(dist, 'editor', 'index.html'))) throw new Error('Run `npm run build:site` first.');
mkdirSync(out, { recursive: true });

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.woff2': 'font/woff2', '.svg': 'image/svg+xml' };
const FORUM = `<!doctype html><meta charset="utf-8"><title>Reply</title>
<style>body{margin:0;font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;color:#26282a;background:#f6f6f4}
main{max-width:640px;margin:0 auto;padding:28px 24px}h1{font-size:19px;font-weight:600;margin:0 0 4px}.sub{color:#6b6f73;font-size:13px;margin:0 0 18px}
.post{background:#fff;border:1px solid #e3e3e0;border-radius:10px;padding:14px 16px;margin:0 0 20px}
label{display:block;font-weight:600;font-size:14px;margin:0 0 6px}textarea{width:100%;box-sizing:border-box;height:120px;font:15px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif;padding:10px 12px;border:1px solid #c9c9c5;border-radius:8px;resize:none}
.acts{display:flex;justify-content:flex-end;margin-top:10px}.acts span{background:#26282a;color:#fff;border-radius:8px;padding:7px 14px;font-size:13px}</style>
<main><h1>Weekend volunteers for the food bank</h1><p class="sub">Posted by the organisers · 14 replies</p>
<div class="post">We need six more people on Saturday from 9:00 to sort and pack donations. Reply here if you can help.</div>
<label for="r">Your reply</label><textarea id="r"></textarea><div class="acts"><span>Post reply</span></div></main>`;

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/forum') { res.setHeader('content-type', 'text/html'); return res.end(FORUM); }
  let p = normalize(join(dist, decodeURIComponent(url.pathname)));
  if (!p.startsWith(dist)) { res.statusCode = 403; return res.end(); }
  if (existsSync(p) && statSync(p).isDirectory()) p = join(p, 'index.html');
  if (!existsSync(p)) { res.statusCode = 404; return res.end(); }
  res.setHeader('content-type', TYPES[extname(p)] ?? 'application/octet-stream');
  res.end(readFileSync(p));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const profile = mkdtempSync(join(tmpdir(), 'gm-shots-'));
const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-pipe', '--enable-unsafe-extension-debugging', '--hide-scrollbars',
  `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--force-color-profile=srgb'],
  { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] });
let buf = '', nextId = 1; const pending = new Map();
chrome.stdio[4].on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\0')) >= 0) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); const p = m.id && pending.get(m.id); if (p) { pending.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); } } });
const send = (method, params = {}, sessionId) => new Promise((res, rej) => { const id = nextId++; pending.set(id, { res, rej }); chrome.stdio[3].write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + '\0'); });

async function open(url, w, h, dpr) {
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId: sid } = await send('Target.attachToTarget', { targetId, flatten: true });
  await send('Page.enable', {}, sid);
  await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: dpr, mobile: w < 600 }, sid);
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }, { name: 'prefers-reduced-motion', value: 'reduce' }] }, sid);
  await send('Page.navigate', { url }, sid);
  return sid;
}
const js = async (sid, expression) => (await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sid)).result.value;
async function until(sid, expression, ms = 30000) {
  for (const t0 = Date.now(); Date.now() - t0 < ms; await sleep(200)) if (await js(sid, expression)) return;
  throw new Error(`timed out waiting for ${expression}`);
}
const rectOf = (sid, sel) => js(sid, `(() => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return { x: r.left, y: r.top, width: r.width, height: r.height }; })()`);
async function shoot(sid, name, clip) {
  const { data } = await send('Page.captureScreenshot', { format: 'webp', quality: 82, ...(clip ? { clip: { ...clip, scale: 1 } } : {}) }, sid);
  writeFileSync(join(out, `${name}.webp`), Buffer.from(data, 'base64'));
  console.log(`${name}.webp  ${(Buffer.from(data, 'base64').length / 1024).toFixed(0)} KB`);
}
const caretIn = (sid, word) => js(sid, `(() => { const t = document.querySelector('.editor-input'); const i = t.value.indexOf(${JSON.stringify(word)}); t.focus(); t.setSelectionRange(i + 1, i + 1); t.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowRight', bubbles: true })); t.dispatchEvent(new Event('select', { bubbles: true })); document.dispatchEvent(new Event('selectionchange')); })()`);
const ready = `/^\\d+ suggestions?$/.test(document.querySelector('.sidebar-head h2')?.textContent ?? '')`;

try {
  // 1. Desktop editor with the caret in a word: its card opens under the word and in the list (hero).
  let sid = await open(`${base}/editor/`, 1200, 700, 1.5);
  await until(sid, ready);
  await caretIn(sid, 'recieve');
  await sleep(500);
  await shoot(sid, 'editor-inline');

  // 3. The suggestion list on its own (feature card).
  await js(sid, `document.querySelector('.editor-input').blur(); document.querySelectorAll('.card.is-open .card-summary').forEach((b) => b.click())`);
  await sleep(300);
  const side = await rectOf(sid, '.sidebar');
  await shoot(sid, 'editor-suggestions', { x: side.x - 16, y: side.y - 8, width: side.width + 32, height: Math.min(side.height + 16, 420) });

  // 4. Settings: language and dictionary, then the optional AI section (feature cards).
  await js(sid, `[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Settings').click()`);
  await sleep(500);
  const dlg = await rectOf(sid, '.dialog');
  await shoot(sid, 'editor-settings', { x: dlg.x, y: dlg.y, width: dlg.width, height: Math.min(dlg.height, 360) });
  await js(sid, `document.querySelector('.ai-group').scrollIntoView({ block: 'start' })`);
  await sleep(300);
  const ai = await rectOf(sid, '.ai-group');
  await shoot(sid, 'editor-ai', { x: ai.x - 8, y: ai.y - 8, width: ai.width + 16, height: Math.min(ai.height + 16, 420) });

  // 5. Phone: the inline card on a word. A tight crop (the word and its whole card) for the hero on
  //    phones, and the full screen for the editor section.
  sid = await open(`${base}/editor/`, 390, 760, 1.5);
  await until(sid, ready);
  await caretIn(sid, 'Its');
  await sleep(500);
  await shoot(sid, 'editor-phone', { x: 0, y: 0, width: 390, height: 760 });
  const word = await js(sid, `(() => { const r = document.querySelector('.editor-input').getBoundingClientRect(); return r.top; })()`);
  const pop = await rectOf(sid, '.popover');
  await shoot(sid, 'editor-phone-fix', { x: 0, y: word - 14, width: 390, height: pop.y + pop.height + 14 - (word - 14) });

  // 6. The extension on a forum reply box, with its card open (extension section).
  await send('Extensions.loadUnpacked', { path: extDir });
  sid = await open(`${base}/forum`, 640, 460, 1.5);
  await sleep(1500);
  await js(sid, `document.getElementById('r').focus()`);
  await send('Input.insertText', { text: 'Count me in for Saturday. Their are three of us from the running club, and we can stay alot longer if you need help packing.' }, sid);
  await sleep(2500);
  // Put the caret in "Their" and release the mouse there, as a click does: the extension opens its card.
  await js(sid, `(() => { const t = document.getElementById('r'); const i = t.value.indexOf('Their'); t.setSelectionRange(i + 2, i + 2); t.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })); })()`);
  await sleep(700);
  await shoot(sid, 'extension-card');
} finally {
  chrome.kill('SIGTERM');
  server.close();
  await sleep(300);
  rmSync(profile, { recursive: true, force: true });
}
