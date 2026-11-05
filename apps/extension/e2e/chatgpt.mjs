// End-to-end check of "Check with ChatGPT" with a MOCK OpenAI server. Real extension, real
// companion (launched by Chrome through native messaging), real Chrome. Only OpenAI is replaced.
//
//   node e2e/chatgpt.mjs <extension build dir> <companion dist file> <out dir>   (or: npm run e2e:chatgpt)
//
// What is NOT covered here: a real ChatGPT account, OpenAI's real consent screen, and real
// inference. The sign-in step drives the companion directly, because the extension only accepts
// https://auth.openai.com authorization URLs, which the mock can't serve. The companion's own tests
// cover the sign-in flow against a mock server too.
import { spawn } from 'node:child_process';
import { generateKeyPairSync, sign as rsaSign, createHash } from 'node:crypto';
import { chmodSync, copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import http from 'node:http';

const [extDir, companionDist, outDir] = process.argv.slice(2).map((p) => resolve(p));
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const EXT_ID = 'cflaepodgccnfddlhomomhbmhgkgikhf';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
mkdirSync(outDir, { recursive: true });
const report = { mocked: 'OpenAI auth + API are a local mock; no real ChatGPT account was used' };

/* ------------------------------------------------------------------ mock OpenAI */
const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'e2e', alg: 'RS256', use: 'sig' };
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const signJwt = (claims) => {
  const head = b64({ alg: 'RS256', kid: 'e2e', typ: 'JWT' });
  const body = b64(claims);
  return `${head}.${body}.${rsaSign('sha256', Buffer.from(`${head}.${body}`), privateKey).toString('base64url')}`;
};
const SCOPE = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
const seen = { responses: [], revoked: 0, aborted: 0 };
const codes = new Map();
let origin = '';
const json = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};
const mock = http.createServer((req, res) => {
  const url = new URL(req.url, origin);
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    switch (url.pathname) {
      case '/.well-known/openid-configuration':
        return json(res, 200, {
          issuer: origin,
          authorization_endpoint: `${origin}/api/accounts/authorize`,
          token_endpoint: `${origin}/api/accounts/oauth/token`,
          revocation_endpoint: `${origin}/api/accounts/oauth/revoke`,
          jwks_uri: `${origin}/.well-known/jwks.json`,
        });
      case '/.well-known/jwks.json':
        return json(res, 200, { keys: [jwk] });
      case '/api/accounts/authorize': {
        const q = url.searchParams;
        seen.authorize = Object.fromEntries(q);
        const code = `code-${codes.size + 1}`;
        codes.set(code, { nonce: q.get('nonce'), challenge: q.get('code_challenge'), redirect: q.get('redirect_uri') });
        const back = new URL(q.get('redirect_uri'));
        back.searchParams.set('code', code);
        back.searchParams.set('state', q.get('state'));
        back.searchParams.set('client_id', 'oaiapp_e2e');
        res.writeHead(302, { location: back.href });
        return res.end();
      }
      case '/api/accounts/oauth/token': {
        const f = new URLSearchParams(body);
        const grant = codes.get(f.get('code'));
        const pkceOk = grant && createHash('sha256').update(f.get('code_verifier') ?? '').digest('base64url') === grant.challenge;
        if (!grant || !pkceOk || f.get('redirect_uri') !== grant.redirect || f.get('client_id') !== 'oaiapp_e2e') return json(res, 400, { error: 'invalid_grant' });
        const now = Math.floor(Date.now() / 1000);
        return json(res, 200, {
          access_token: 'e2e-access',
          refresh_token: 'e2e-refresh',
          id_token: signJwt({ iss: origin, aud: 'oaiapp_e2e', sub: 'user-e2e', email: 'you@example.com', name: 'You', nonce: grant.nonce, iat: now, exp: now + 3600 }),
          token_type: 'Bearer',
          expires_in: 3600,
          scope: SCOPE,
        });
      }
      case '/api/accounts/oauth/revoke':
        seen.revoked++;
        res.writeHead(200);
        return res.end();
      case '/v1/models':
        if (req.headers.authorization !== 'Bearer e2e-access') return json(res, 401, { detail: 'Unauthorized' });
        return json(res, 200, {
          models: [
            { slug: 'plan-model', display_name: 'Your plan’s model', visibility: 'list' },
            { slug: 'plan-model-mini', display_name: 'Your plan’s smaller model', visibility: 'list' },
            { slug: 'internal', display_name: 'Hidden', visibility: 'hide' },
          ],
        });
      case '/v1/responses': {
        if (req.headers.authorization !== 'Bearer e2e-access') return json(res, 401, { detail: 'Unauthorized' });
        const b = JSON.parse(body);
        const text = JSON.stringify(b.input);
        seen.responses.push({
          model: b.model,
          store: b.store,
          stream: b.stream,
          hasInstructions: typeof b.instructions === 'string',
          forbidden: Object.keys(b).filter((k) => ['temperature', 'max_output_tokens', 'tools', 'metadata', 'user', 'text'].includes(k)),
          chars: text.length,
        });
        if (text.includes('LIMIT')) return json(res, 429, { error: { code: 'subscription_sharing_usage_limit_exceeded', message: 'limit' } });
        if (text.includes('SLOW')) {
          res.on('close', () => seen.aborted++);
          return; // never answers; the user cancels
        }
        const edits = [];
        if (text.includes('I has')) edits.push({ original: 'I has', replacement: 'I have', category: 'grammar', message: 'Use “have” with “I”.' });
        if (text.includes('a orange')) edits.push({ original: 'a orange', replacement: 'an orange', category: 'grammar', message: 'Use “an” before a vowel sound.' });
        if (text.includes('5 apples')) edits.push({ original: '5 apples', replacement: 'five apples', category: 'grammar', message: 'Spell out small numbers.' });
        const answer = text.includes('OK?') ? 'OK' : JSON.stringify({ edits });
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        const events = [
          ...answer.match(/.{1,12}/g).map((d) => ({ type: 'response.output_text.delta', delta: d })),
          { type: 'response.completed', response: { status: 'completed' } },
        ];
        return res.end(events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''));
      }
      default:
        return json(res, 404, {});
    }
  });
});
await new Promise((r) => mock.listen(0, '127.0.0.1', r));
origin = `http://127.0.0.1:${mock.address().port}`;

/* ------------------------------------------------------------------ companion (isolated) */
const tmp = mkdtempSync(join(tmpdir(), 'gm-chatgpt-e2e-'));
const companionHome = join(tmp, 'companion-home');
const profile = join(tmp, 'chrome-profile');
mkdirSync(companionHome, { recursive: true, mode: 0o700 });
mkdirSync(join(profile, 'NativeMessagingHosts'), { recursive: true });
const hostCopy = join(tmp, 'grammarme-companion.mjs');
copyFileSync(companionDist, hostCopy);
const env = {
  GRAMMARME_COMPANION_HOME: companionHome,
  GRAMMARME_COMPANION_TEST_AUTH_ORIGIN: origin,
  GRAMMARME_COMPANION_TEST_API_ORIGIN: origin,
};
const launcher = join(tmp, 'launcher.sh');
writeFileSync(
  launcher,
  `#!/bin/sh\n${Object.entries(env).map(([k, v]) => `export ${k}='${v}'`).join('\n')}\nexec '${process.execPath}' '${hostCopy}' "$@"\n`,
);
chmodSync(launcher, 0o755);
// Chrome looks for user-level hosts inside the profile it was started with. Registered later,
// while the popup is open, to test the guided setup.
const registerHost = () =>
  writeFileSync(
    join(profile, 'NativeMessagingHosts', 'com.grammarme.chatgpt.json'),
    JSON.stringify({ name: 'com.grammarme.chatgpt', description: 'GrammarMe e2e', path: launcher, type: 'stdio', allowed_origins: [`chrome-extension://${EXT_ID}/`] }),
  );

/** Talk to the companion over native-messaging framing, as Chrome would. */
function hostSession() {
  const p = spawn(launcher, [`chrome-extension://${EXT_ID}/`], { stdio: ['pipe', 'pipe', 'pipe'] });
  let buf = Buffer.alloc(0);
  const waiters = [];
  const inbox = [];
  p.stdout.on('data', (d) => {
    buf = Buffer.concat([buf, d]);
    while (buf.length >= 4) {
      const n = buf.readUInt32LE(0);
      if (buf.length < 4 + n) break;
      const msg = JSON.parse(buf.subarray(4, 4 + n).toString('utf8'));
      buf = buf.subarray(4 + n);
      const w = waiters.findIndex((x) => x.match(msg));
      if (w >= 0) waiters.splice(w, 1)[0].resolve(msg);
      else inbox.push(msg);
    }
  });
  return {
    send(m) {
      const body = Buffer.from(JSON.stringify(m));
      const head = Buffer.alloc(4);
      head.writeUInt32LE(body.length);
      p.stdin.write(Buffer.concat([head, body]));
    },
    next(match) {
      const i = inbox.findIndex(match);
      if (i >= 0) return Promise.resolve(inbox.splice(i, 1)[0]);
      return new Promise((resolve) => waiters.push({ match, resolve }));
    },
    close() {
      p.stdin.end();
    },
  };
}

// Sign in: the companion opens its 127.0.0.1 callback, we play the browser against the mock.
{
  const s = hostSession();
  s.send({ id: 'signin1', type: 'signIn' });
  const auth = await s.next((m) => m.type === 'authUrl');
  const redirected = await fetch(auth.url, { redirect: 'follow' });
  const done = await s.next((m) => m.type === 'done');
  report.signIn = {
    authUrlOrigin: new URL(auth.url).origin === origin,
    callbackPage: redirected.status,
    ok: done.ok,
    planUsage: done.status?.account?.planUsage,
    email: done.status?.account?.email,
    scopeRequested: seen.authorize?.scope,
    redirectUri: seen.authorize?.redirect_uri,
    pkce: seen.authorize?.code_challenge_method,
  };
  s.close();
  const cred = readFileSync(join(companionHome, 'chatgpt.json'), 'utf8');
  report.credentialFileMode = (await import('node:fs')).statSync(join(companionHome, 'chatgpt.json')).mode & 0o777;
  report.credentialsHaveTokens = cred.includes('e2e-refresh');
}

/* ------------------------------------------------------------------ Chrome + extension */
// Test copy of the build: nativeMessaging made a required permission, because automation can't
// click Chrome's permission prompt for the optional one. Everything else is the shipped build.
const extCopy = join(tmp, 'extension');
cpSync(extDir, extCopy, { recursive: true });
const manifest = JSON.parse(readFileSync(join(extCopy, 'manifest.json'), 'utf8'));
manifest.permissions = [...manifest.permissions, 'nativeMessaging'];
delete manifest.optional_permissions;
writeFileSync(join(extCopy, 'manifest.json'), JSON.stringify(manifest));

const PAGE = `<!doctype html><meta charset="utf-8"><title>Reply</title><style>body{font:16px system-ui;margin:40px;background:#fff}textarea{width:640px;height:140px;font:16px system-ui;padding:10px}</style><h3>Reply</h3><textarea id="ta"></textarea>`;
const site = http.createServer((q, r) => { r.setHeader('content-type', 'text/html'); r.end(PAGE); });
await new Promise((r) => site.listen(0, '127.0.0.1', r));
const pageUrl = `http://127.0.0.1:${site.address().port}/`;

const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-pipe', '--enable-unsafe-extension-debugging', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--window-size=1100,800'], { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] });
let cbuf = '', nextId = 1; const pending = new Map(); const events = [];
chrome.stdio[4].on('data', (d) => { cbuf += d; let i; while ((i = cbuf.indexOf('\0')) >= 0) { const m = JSON.parse(cbuf.slice(0, i)); cbuf = cbuf.slice(i + 1); const p = m.id && pending.get(m.id); if (p) { pending.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); } else events.push(m); } });
const send = (method, params = {}, sessionId) => new Promise((res, rej) => { const id = nextId++; pending.set(id, { res, rej }); chrome.stdio[3].write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + '\0'); });
const js = async (sid, e) => (await send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true }, sid)).result.value;
const shot = async (sid, name, clip) => { const { data } = await send('Page.captureScreenshot', { format: 'png', ...(clip ? { clip: { ...clip, scale: 1 } } : {}) }, sid); writeFileSync(join(outDir, name), Buffer.from(data, 'base64')); };
async function tab(url, w, h, dpr = 1) {
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId: sid } = await send('Target.attachToTarget', { targetId, flatten: true });
  await send('Page.enable', {}, sid); await send('Runtime.enable', {}, sid); await send('DOM.enable', {}, sid);
  await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: dpr, mobile: false }, sid);
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] }, sid);
  await send('Page.navigate', { url }, sid);
  return sid;
}
async function overlay(sid) {
  const { root } = await send('DOM.getDocument', { depth: -1, pierce: true }, sid);
  const out = [];
  const walk = (n, inO) => { const here = inO || n.nodeName === 'GRAMMARME-OVERLAY'; if (here && n.nodeType === 1) { const a = {}; for (let i = 0; i < (n.attributes || []).length; i += 2) a[n.attributes[i]] = n.attributes[i + 1]; out.push({ name: n.nodeName, cls: a.class || '', hidden: 'hidden' in a, backendNodeId: n.backendNodeId, text: (n.children || []).filter((c) => c.nodeType === 3).map((c) => c.nodeValue).join('') }); } for (const c of [...(n.children || []), ...(n.shadowRoots || [])]) walk(c, here); };
  walk(root, false);
  return out;
}
const center = async (sid, backendNodeId) => { const { model } = await send('DOM.getBoxModel', { backendNodeId }, sid); const q = model.border; return { x: (q[0] + q[2]) / 2, y: (q[1] + q[5]) / 2 }; };
const click = async (sid, pt) => { for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x: pt.x, y: pt.y, button: 'left', clickCount: 1 }, sid); };
const clickText = async (sid, text) => { const n = (await overlay(sid)).find((x) => x.name === 'BUTTON' && x.text === text); if (!n) throw new Error(`no button "${text}"`); await click(sid, await center(sid, n.backendNodeId)); };
const panelText = async (sid) => (await overlay(sid)).filter((x) => /^msg|notice|preview|title|lnk/.test(x.cls)).map((x) => x.text).join(' | ');
async function until(fn, ms = 15000) { for (const t0 = Date.now(); Date.now() - t0 < ms; await sleep(250)) { const v = await fn(); if (v) return v; } return null; }
const popupText = (sid) => js(sid, `document.getElementById('ai-body').innerText`);

try {
  const { id } = await send('Extensions.loadUnpacked', { path: extCopy });
  report.extensionId = id;

  // 0. Guided setup: no companion yet → step 1 with the install command; installing it while the
  //    popup is open moves it on by itself.
  let popup = await tab(`chrome-extension://${id}/popup.html`, 310, 620, 2);
  report.guidedStep1 = await until(async () => { const t = await popupText(popup); return /Step 1 of 2/.test(t) ? t : null; });
  report.guidedCommand = await js(popup, `document.querySelector('.cmd code')?.textContent ?? null`);
  await shot(popup, 'popup-step1.png');
  registerHost();
  report.guidedAdvanced = Boolean(await until(async () => /Connected as you@example.com/.test(await popupText(popup)), 12000));

  // 1. Popup: status, models, test.
  report.popupConnected = await until(async () => /Connected as you@example.com/.test(await popupText(popup)) && (await popupText(popup)));
  if (!report.popupConnected) report.popupShows = await popupText(popup);
  if (!report.popupConnected) report.popupDebug = await js(popup, `(async () => ({ perms: chrome.runtime.getManifest().permissions, has: await chrome.permissions.contains({ permissions: ['nativeMessaging'] }), status: await chrome.runtime.sendMessage({ target: 'background', type: 'aiStatus' }) }))()`);
  report.popupModels = await until(() => js(popup, `(() => { const s = document.querySelector('#ai-body select'); return s && !s.disabled ? [...s.options].map((o) => o.textContent) : null; })()`));
  await js(popup, `[...document.querySelectorAll('#ai-body button')].find((b) => b.textContent === 'Test connection').click()`);
  report.popupTest = await until(async () => { const t = await popupText(popup); return /Working|Couldn|error/i.test(t) ? t.split('\n').pop() : null; });
  await shot(popup, 'popup-connected.png');

  // 2. A text box: local underlines first, then the AI button.
  const page = await tab(pageUrl, 1000, 640, 1.5);
  await sleep(1200);
  await js(page, `document.getElementById('ta').focus()`);
  await send('Input.insertText', { text: 'I has 5 apples and a orange for the trip.' }, page);
  report.localUnderlines = (await until(async () => { const u = (await overlay(page)).filter((n) => /^u( |$)/.test(n.cls)); return u.length ? u.map((n) => n.text) : null; }, 10000)) ?? [];
  const aiBtn = await until(async () => (await overlay(page)).find((n) => n.cls === 'aibtn' && !n.hidden));
  report.aiButtonShown = Boolean(aiBtn);
  await click(page, await center(page, aiBtn.backendNodeId));
  await sleep(400);
  report.preview = await panelText(page);
  await shot(page, 'ai-panel.png');

  // 3. Send, get edits, accept one, undo it.
  await clickText(page, 'Send to ChatGPT');
  report.result = await until(async () => { const t = await panelText(page); return /suggested/.test(t) ? t : null; });
  await shot(page, 'ai-result.png');
  await clickText(page, 'Done');
  const span = (await overlay(page)).find((n) => /^u( |$)/.test(n.cls) && n.text === 'I has');
  await js(page, `(() => { const t = document.getElementById('ta'); const i = t.value.indexOf('I has'); t.focus(); t.setSelectionRange(i + 1, i + 1); t.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })); })()`);
  await sleep(500);
  report.aiCard = (await overlay(page)).filter((n) => /cat|repl/.test(n.cls)).map((n) => n.text);
  await shot(page, 'ai-card.png');
  await clickText(page, 'I have');
  await sleep(500);
  report.afterAccept = await js(page, `document.getElementById('ta').value`);
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'z', code: 'KeyZ', modifiers: 4, commands: ['undo'] }, page);
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'z', code: 'KeyZ', modifiers: 4 }, page);
  await sleep(400);
  report.afterUndo = await js(page, `document.getElementById('ta').value`);
  void span;

  // 4. Usage limit: clear message, Manage usage link, local checks untouched.
  await js(page, `(() => { const t = document.getElementById('ta'); t.focus(); t.select(); })()`);
  await send('Input.insertText', { text: 'Please check LIMIT this sentense.' }, page);
  await sleep(900);
  await click(page, await center(page, (await overlay(page)).find((n) => n.cls === 'aibtn' && !n.hidden).backendNodeId));
  await sleep(300);
  await clickText(page, 'Send to ChatGPT');
  report.usageLimit = await until(async () => { const t = await panelText(page); return /usage limit/i.test(t) ? t : null; });
  report.localStillWorks = (await overlay(page)).some((n) => /^u( |$)/.test(n.cls) && n.text === 'sentense');
  await clickText(page, 'Close');

  // 5. Cancel a slow request.
  await js(page, `(() => { const t = document.getElementById('ta'); t.focus(); t.select(); })()`);
  await send('Input.insertText', { text: 'A SLOW request that I will cancel.' }, page);
  await sleep(600);
  await click(page, await center(page, (await overlay(page)).find((n) => n.cls === 'aibtn' && !n.hidden).backendNodeId));
  await sleep(300);
  await clickText(page, 'Send to ChatGPT');
  await sleep(800);
  await clickText(page, 'Cancel');
  report.cancelled = await until(async () => { const t = await panelText(page); return /cancelled/i.test(t) ? t : null; });
  await sleep(800);
  report.mockSawAbort = seen.aborted > 0;
  await clickText(page, 'Close');

  // 6. Disconnect from the popup: revoke + delete credentials; the AI button disappears.
  await send('Page.reload', {}, popup);
  await until(async () => /Connected/.test(await popupText(popup)));
  await js(popup, `[...document.querySelectorAll('#ai-body button')].find((b) => b.textContent === 'Disconnect').click()`);
  report.disconnected = await until(async () => { const t = await popupText(popup); return /Disconnected/.test(t) ? t : null; });
  report.revokeCalls = seen.revoked;
  report.credentialsHaveTokensAfter = readFileSync(join(companionHome, 'chatgpt.json'), 'utf8').includes('e2e-refresh');
  await shot(popup, 'popup-disconnected.png');
  await sleep(600);
  report.aiButtonAfterDisconnect = (await overlay(page)).some((n) => n.cls === 'aibtn' && !n.hidden);

  report.requestsToOpenAI = seen.responses;
  report.exceptions = events.filter((e) => e.method === 'Runtime.exceptionThrown').map((e) => e.params.exceptionDetails.exception?.description?.slice(0, 200) || e.params.exceptionDetails.text);
} catch (err) {
  report.error = String(err.stack || err);
} finally {
  writeFileSync(join(outDir, 'chatgpt-report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  chrome.kill('SIGTERM');
  mock.close();
  site.close();
  await sleep(500);
  rmSync(tmp, { recursive: true, force: true });
}
