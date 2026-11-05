// End-to-end check of the built extension in a throwaway headless Chrome: plain text boxes (<textarea>, <input>, password).
// Usage: node e2e/fields.mjs <extension build dir> <screenshot dir>   (or: npm run e2e)
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

const PAGE = `<!doctype html><meta charset="utf-8"><title>Test forum</title>
<style>body{font:16px system-ui;margin:40px;background:#fff} textarea{width:600px;height:160px;font:16px system-ui;padding:10px} input{width:400px;font:16px system-ui;padding:6px;margin:8px 0;display:block}</style>
<h1>Reply</h1>
<textarea id="ta"></textarea>
<input id="txt" type="text" placeholder="subject">
<input id="pw" type="password">`;
const server = http.createServer((q, s) => { s.setHeader('content-type', 'text/html'); s.end(PAGE); });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const pageUrl = `http://127.0.0.1:${server.address().port}/`;

const profile = mkdtempSync(join(tmpdir(), 'gm-ext-'));
const chrome = spawn(CHROME, [
  '--headless=new', '--remote-debugging-pipe', '--enable-unsafe-extension-debugging',
  `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--window-size=1100,800',
], { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] });

let buf = '', nextId = 1;
const pending = new Map();
const events = [];
chrome.stdio[4].on('data', (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf('\0')) >= 0) {
    const msg = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
    if (msg.id && pending.has(msg.id)) { const p = pending.get(msg.id); pending.delete(msg.id); msg.error ? p.rej(new Error(JSON.stringify(msg.error))) : p.res(msg.result); }
    else events.push(msg);
  }
});
const send = (method, params = {}, sessionId) => new Promise((res, rej) => {
  const id = nextId++; pending.set(id, { res, rej });
  chrome.stdio[3].write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + '\0');
});
const report = {};
const evalIn = async (sid, expression) => (await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sid)).result.value;
const shot = async (sid, name) => { const { data } = await send('Page.captureScreenshot', { format: 'png' }, sid); writeFileSync(join(outDir, name), Buffer.from(data, 'base64')); };

// Every node inside the overlay's closed shadow root, via DOM.getDocument(pierce).
async function overlayNodes(sid) {
  const { root } = await send('DOM.getDocument', { depth: -1, pierce: true }, sid);
  const out = [];
  const walk = (n, inOverlay) => {
    const here = inOverlay || n.nodeName === 'GRAMMARME-OVERLAY';
    if (here && n.nodeType === 1) {
      const attrs = {}; for (let i = 0; i < (n.attributes || []).length; i += 2) attrs[n.attributes[i]] = n.attributes[i + 1];
      out.push({ name: n.nodeName, attrs, nodeId: n.nodeId, backendNodeId: n.backendNodeId, text: (n.children || []).filter((c) => c.nodeType === 3).map((c) => c.nodeValue).join('') });
    }
    for (const c of [...(n.children || []), ...(n.shadowRoots || [])]) walk(c, here);
  };
  walk(root, false);
  return out;
}
async function boxOf(sid, backendNodeId) {
  const { model } = await send('DOM.getBoxModel', { backendNodeId }, sid);
  const q = model.border; return { x: (q[0] + q[2]) / 2, y: (q[1] + q[5]) / 2 };
}
async function click(sid, { x, y }) {
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased'])
    await send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 }, sid);
}

try {
  const { id: extId } = await send('Extensions.loadUnpacked', { path: extDir });
  report.extensionId = extId;

  const { targetId } = await send('Target.createTarget', { url: pageUrl });
  const { sessionId: sid } = await send('Target.attachToTarget', { targetId, flatten: true });
  await send('Page.enable', {}, sid); await send('Runtime.enable', {}, sid); await send('DOM.enable', {}, sid);
  await sleep(1500);

  // 1. textarea: type text with mistakes, wait for the check.
  await evalIn(sid, `document.getElementById('ta').focus()`);
  await send('Input.insertText', { text: 'I has a apple. This is a sentense with a eror.' }, sid);
  const t0 = Date.now();
  let marks = [];
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    marks = (await overlayNodes(sid)).filter((n) => /^u( |$)/.test(n.attrs.class || ''));
    if (marks.length) break;
  }
  report.firstCheckMs = Date.now() - t0;
  const nodes = await overlayNodes(sid);
  report.overlayClasses = [...new Set(nodes.map((n) => `${n.name.toLowerCase()}.${n.attrs.class || ''}`))];
  report.underlines = marks.map((m) => m.text);
  await shot(sid, '1-textarea.png');

  // 2. click the first underline, look for the card, accept the first fix.
  if (marks[0]) {
    const pt = await boxOf(sid, marks[0].backendNodeId).catch(() => null);
    report.markBox = pt;
    if (pt) await click(sid, pt);
    await sleep(800);
    await shot(sid, '2-card.png');
    const after = await overlayNodes(sid);
    report.cardButtons = after.filter((n) => n.name === 'BUTTON').map((n) => `${n.attrs.class || ''}:${n.text}`);
    const fix = after.find((n) => n.name === 'BUTTON' && /^repl/.test(n.attrs.class || ''));
    if (fix) {
      await click(sid, await boxOf(sid, fix.backendNodeId));
      await sleep(1500);
      report.textAfterAccept = await evalIn(sid, `document.getElementById('ta').value`);
      await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'z', code: 'KeyZ', modifiers: 4, commands: ['undo'] }, sid);
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'z', code: 'KeyZ', modifiers: 4 }, sid);
      await sleep(500);
      report.textAfterUndo = await evalIn(sid, `document.getElementById('ta').value`);
      await shot(sid, '3-accepted.png');
    }
  }

  // 2b. Drag the badge (like Grammarly's button): it moves, no card opens, the spot is remembered
  //     after a reload, a plain click still opens a card, and the toolbar menu can reset it.
  {
    const badgeNode = async () => (await overlayNodes(sid)).find((n) => /\bbadge\b/.test(n.attrs.class || ''));
    const badgeAt = async () => { const b = await badgeNode(); return b ? await boxOf(sid, b.backendNodeId) : null; };
    await evalIn(sid, `document.getElementById('ta').focus()`);
    await sleep(300);
    const from = await badgeAt();
    const to = { x: from.x - 380, y: from.y - 110 };
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x, y: from.y }, sid);
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: from.x, y: from.y, button: 'left', clickCount: 1 }, sid);
    for (let i = 1; i <= 8; i++) {
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x + ((to.x - from.x) * i) / 8, y: from.y + ((to.y - from.y) * i) / 8, button: 'left', buttons: 1 }, sid);
    }
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: to.x, y: to.y, button: 'left', clickCount: 1 }, sid);
    await sleep(500);
    const moved = await badgeAt();
    report.badgeDrag = {
      from: [Math.round(from.x), Math.round(from.y)],
      to: moved ? [Math.round(moved.x), Math.round(moved.y)] : null,
      cardOpenedByDrag: (await overlayNodes(sid)).some((n) => /^card\b/.test(n.attrs.class || '')),
    };
    await shot(sid, '2b-badge-moved.png');

    // Remembered after reloading the page.
    await send('Page.reload', {}, sid);
    await sleep(1500);
    await evalIn(sid, `document.getElementById('ta').focus()`);
    await send('Input.insertText', { text: 'Teh badge stays put.' }, sid);
    await sleep(1500);
    const after = await badgeAt();
    report.badgeAfterReload = after ? [Math.round(after.x), Math.round(after.y)] : null;

    // A plain click (no movement) still opens the first suggestion.
    await click(sid, after);
    await sleep(500);
    report.badgeClickOpensCard = (await overlayNodes(sid)).some((n) => /^card\b/.test(n.attrs.class || ''));

    // The toolbar menu offers a reset for this site; using it puts the badge back.
    const { targetId: popId } = await send('Target.createTarget', { url: `chrome-extension://${extId}/popup.html` });
    const { sessionId: psid0 } = await send('Target.attachToTarget', { targetId: popId, flatten: true });
    await send('Runtime.enable', {}, psid0);
    await sleep(1000);
    report.badgeStored = await evalIn(psid0, `chrome.storage.local.get('badgePositions').then((r) => r.badgePositions)`);
    // (The popup opened as a tab can't see the page's host, so reset through storage, as the menu does.)
    await evalIn(psid0, `chrome.storage.local.set({ badgePositions: {} })`);
    await send('Target.closeTarget', { targetId: popId });
    await sleep(800);
    await evalIn(sid, `document.getElementById('ta').focus()`);
    await sleep(500);
    const reset = await badgeAt();
    report.badgeAfterReset = reset ? [Math.round(reset.x), Math.round(reset.y)] : null;
    await evalIn(sid, `(() => { const t = document.getElementById('ta'); t.value = 'I has a apple. This is a sentense with a eror.'; t.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await sleep(1200);
  }

  // 3. password field must be ignored.
  await evalIn(sid, `document.getElementById('pw').focus()`);
  await send('Input.insertText', { text: 'teh pasword' }, sid);
  await sleep(3000);
  report.overlayHostsAfterPassword = (await overlayNodes(sid)).filter((n) => n.name === 'GRAMMARME-OVERLAY').length;

  // 4. text input.
  await evalIn(sid, `document.getElementById('txt').focus()`);
  await send('Input.insertText', { text: 'Recieve teh files' }, sid);
  await sleep(3000);
  report.underlinesInInput = (await overlayNodes(sid)).filter((n) => /^u( |$)/.test(n.attrs.class || '')).map((m) => m.text);
  await shot(sid, '4-input.png');

  // 5. popup page.
  const { targetId: pid } = await send('Target.createTarget', { url: `chrome-extension://${extId}/popup.html` });
  const { sessionId: psid } = await send('Target.attachToTarget', { targetId: pid, flatten: true });
  await send('Page.enable', {}, psid); await send('Runtime.enable', {}, psid);
  await sleep(1500);
  await send('Emulation.setDeviceMetricsOverride', { width: 360, height: 520, deviceScaleFactor: 2, mobile: false }, psid);
  await sleep(300);
  report.popupText = await evalIn(psid, `document.body.innerText.slice(0, 400)`);
  await shot(psid, '5-popup.png');

  // 6. errors seen by any target.
  report.exceptions = events.filter((e) => e.method === 'Runtime.exceptionThrown').map((e) => e.params.exceptionDetails.exception?.description?.slice(0, 200) || e.params.exceptionDetails.text);
  const { targetInfos } = await send('Target.getTargets');
  report.targets = targetInfos.map((t) => `${t.type} ${t.url.replace(/chrome-extension:\/\/[a-z]+/, 'ext:')}`);
} catch (e) {
  report.error = String(e.stack || e);
} finally {
  writeFileSync(join(outDir, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  chrome.kill('SIGTERM'); server.close();
  await sleep(500);
  rmSync(profile, { recursive: true, force: true });
}
