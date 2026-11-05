// End-to-end check of the built extension in a throwaway headless Chrome: rich-text editors (Gmail-style contenteditable, Quill).
// Usage: node e2e/rich.mjs <extension build dir> <screenshot dir>   (or: npm run e2e)
// Uses your installed Chrome (override with CHROME_PATH) with a temporary profile; prints a JSON report.
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';

const [extDir, outDir] = process.argv.slice(2);
mkdirSync(outDir, { recursive: true });
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const STYLE = `<style>body{font:15px Arial,sans-serif;margin:30px;background:#fff;color:#222}
.compose{width:620px;border:1px solid #ccc;border-radius:8px;padding:12px;min-height:180px;max-height:260px;overflow:auto;line-height:1.5}
.gmail_quote{color:#777;border-left:2px solid #ccc;padding-left:8px;margin-top:8px}</style>`;
const PAGES = {
  '/gmail': `<!doctype html><meta charset="utf-8"><title>Compose</title>${STYLE}
<h3>New message</h3>
<div id="ed" class="compose" contenteditable="true" role="textbox" aria-label="Message Body" aria-multiline="true" spellcheck="false"><div><br></div><div class="gmail_quote">On Mon, Sam wrote:<blockquote>Their is teh old messsage.</blockquote></div></div>`,
  '/quill': `<!doctype html><meta charset="utf-8"><title>Quill</title>
<link href="https://cdn.jsdelivr.net/npm/quill@2.0.3/dist/quill.snow.css" rel="stylesheet">${STYLE}
<h3>Quill editor</h3><div id="q" style="width:620px;height:200px"></div>
<script src="https://cdn.jsdelivr.net/npm/quill@2.0.3/dist/quill.js"></script>
<script>window.quill = new Quill('#q', { theme: 'snow' });</script>`,
};
const server = http.createServer((q, s) => { s.setHeader('content-type', 'text/html'); s.end(PAGES[q.url] ?? 'nope'); });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const profile = mkdtempSync(join(tmpdir(), 'gm-ext-'));
const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-pipe', '--enable-unsafe-extension-debugging',
  `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--window-size=1000,700'],
  { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] });
let buf = '', nextId = 1; const pending = new Map(); const events = [];
chrome.stdio[4].on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\0')) >= 0) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); } else events.push(m); } });
const send = (method, params = {}, sessionId) => new Promise((res, rej) => { const id = nextId++; pending.set(id, { res, rej }); chrome.stdio[3].write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + '\0'); });
const evalIn = async (sid, expression) => (await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sid)).result.value;
const shot = async (sid, name) => { const { data } = await send('Page.captureScreenshot', { format: 'png' }, sid); writeFileSync(join(outDir, name), Buffer.from(data, 'base64')); };
async function overlay(sid) {
  const { root } = await send('DOM.getDocument', { depth: -1, pierce: true }, sid);
  const out = [];
  const walk = (n, inO) => { const here = inO || n.nodeName === 'GRAMMARME-OVERLAY'; if (here && n.nodeType === 1) { const a = {}; for (let i = 0; i < (n.attributes || []).length; i += 2) a[n.attributes[i]] = n.attributes[i + 1]; out.push({ name: n.nodeName, cls: a.class || '', style: a.style || '', backendNodeId: n.backendNodeId, text: (n.children || []).filter((c) => c.nodeType === 3).map((c) => c.nodeValue).join('') }); } for (const c of [...(n.children || []), ...(n.shadowRoots || [])]) walk(c, here); };
  walk(root, false); return out;
}
const bars = async (sid) => (await overlay(sid)).filter((n) => /^bar /.test(n.cls));
const boxOf = async (sid, backendNodeId) => { const { model } = await send('DOM.getBoxModel', { backendNodeId }, sid); const q = model.border; return { x: (q[0] + q[2]) / 2, y: (q[1] + q[5]) / 2 }; };
const click = async (sid, { x, y }) => { for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 }, sid); };
const key = async (sid, k, code, modifiers = 0, commands) => { await send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, modifiers, ...(commands ? { commands } : {}) }, sid); await send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, modifiers }, sid); };

async function waitBars(sid, min = 1) { for (let i = 0; i < 30; i++) { await sleep(400); const b = await bars(sid); if (b.length >= min) return b; } return []; }

async function scenario(name, url, selector, textOf) {
  const r = { name };
  const { targetId } = await send('Target.createTarget', { url });
  const { sessionId: sid } = await send('Target.attachToTarget', { targetId, flatten: true });
  await send('Page.enable', {}, sid); await send('Runtime.enable', {}, sid); await send('DOM.enable', {}, sid);
  await sleep(2500);
  // Focus and put the caret at the start of the editor (first line), then type like a person.
  await evalIn(sid, `(() => { const e = document.querySelector(${JSON.stringify(selector)}); e.focus(); const r = document.createRange(); r.setStart(e.firstChild ?? e, 0); r.collapse(true); getSelection().removeAllRanges(); getSelection().addRange(r); })()`);
  await send('Input.insertText', { text: 'Hi Sam, I has a apple for you.' }, sid);
  await key(sid, 'Enter', 'Enter', 0, ['insertParagraph']);
  await send('Input.insertText', { text: 'This sentense has a eror.' }, sid);
  const t0 = Date.now();
  const b = await waitBars(sid, 3);
  r.underlineCount = b.length;
  r.firstCheckMs = Date.now() - t0;
  r.textSeen = await evalIn(sid, textOf);
  await shot(sid, `${name}-1-underlines.png`);
  // Click on the first underlined word (just above its bar), open the card, accept the fix.
  if (b[0]) {
    const p = await boxOf(sid, b[0].backendNodeId);
    await click(sid, { x: p.x, y: p.y - 7 });
    await sleep(700);
    const nodes = await overlay(sid);
    r.card = nodes.filter((n) => n.name === 'BUTTON' && /repl|action/.test(n.cls)).map((n) => n.text);
    await shot(sid, `${name}-2-card.png`);
    const fix = nodes.find((n) => n.name === 'BUTTON' && /^repl/.test(n.cls));
    if (fix) {
      await click(sid, await boxOf(sid, fix.backendNodeId));
      await sleep(1500);
      r.afterAccept = await evalIn(sid, textOf);
      r.underlinesAfterAccept = (await bars(sid)).length;
      await key(sid, 'z', 'KeyZ', 4, ['undo']);
      await sleep(800);
      r.afterUndo = await evalIn(sid, textOf);
      await shot(sid, `${name}-3-after.png`);
    }
  }
  // Scroll the page a little: underlines must follow the text.
  const before = (await bars(sid))[0];
  await evalIn(sid, `window.scrollBy(0, 40)`);
  await sleep(400);
  const after = (await bars(sid))[0];
  r.followsScroll = before && after ? `${before.style.match(/top: ([\d.]+)/)?.[1]} -> ${after.style.match(/top: ([\d.]+)/)?.[1]}` : 'n/a';
  return r;
}

const report = {};
try {
  const { id } = await send('Extensions.loadUnpacked', { path: extDir });
  report.extensionId = id;
  report.gmail = await scenario('gmail', `${base}/gmail`, '#ed', `document.querySelector('#ed').innerText`);
  report.quill = await scenario('quill', `${base}/quill`, '#q .ql-editor', `quill.getText()`);
  report.scroll = await (async () => {
    const r = {};
    const { targetId } = await send('Target.createTarget', { url: `${base}/gmail` });
    const { sessionId: sid } = await send('Target.attachToTarget', { targetId, flatten: true });
    await send('Page.enable', {}, sid); await send('Runtime.enable', {}, sid); await send('DOM.enable', {}, sid);
    await sleep(1500);
    await evalIn(sid, `(() => { const e = document.querySelector('#ed'); e.focus(); const r = document.createRange(); r.setStart(e.firstChild, 0); r.collapse(true); getSelection().removeAllRanges(); getSelection().addRange(r); })()`);
    for (let i = 0; i < 14; i++) { await send('Input.insertText', { text: i % 3 ? 'A normal line of text here.' : 'Line with teh mistake.' }, sid); await key(sid, 'Enter', 'Enter', 0, ['insertParagraph']); }
    await waitBars(sid, 2);
    await sleep(800);
    const edRect = await evalIn(sid, `(() => { const b = document.querySelector('#ed').getBoundingClientRect(); return [b.top, b.bottom]; })()`);
    const tops = async () => (await bars(sid)).map((b) => +b.style.match(/top: ([\d.]+)/)[1]);
    const t1 = await tops();
    await evalIn(sid, `document.querySelector('#ed').scrollTop = 0`);
    await sleep(500);
    const t2 = await tops();
    r.editorBox = edRect.map(Math.round);
    r.barsBefore = t1.map(Math.round);
    r.barsAfterScrollToTop = t2.map(Math.round);
    r.allInside = [...t1, ...t2].every((y) => y >= edRect[0] && y <= edRect[1]);
    await shot(sid, 'scroll.png');
    return r;
  })();
  report.exceptions = events.filter((e) => e.method === 'Runtime.exceptionThrown').map((e) => e.params.exceptionDetails.exception?.description?.slice(0, 300) || e.params.exceptionDetails.text);
} catch (e) { report.error = String(e.stack || e); }
finally {
  console.log(JSON.stringify(report, null, 2));
  chrome.kill('SIGTERM'); server.close(); await sleep(500); rmSync(profile, { recursive: true, force: true });
}
