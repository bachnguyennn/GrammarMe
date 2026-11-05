/** `grammarme-companion doctor`: a read-only health report. Never prints token values. */
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { COMPANION_HOST } from '@grammarme/core/companion';
import { companionHome, resolveEndpoints } from './config.ts';
import { getJson } from './http.ts';
import type { FetchFn } from './http.ts';
import { BROWSERS, browserDataDirs, INSTALLED_BINARY_NAME, installDir, isExecutable, LAUNCHER_NAME, MANIFEST_FILE, nodePathFromLauncher } from './install.ts';
import type { Platform } from './install.ts';
import { loadAllowedExtensionIds } from './origin.ts';
import { CREDENTIALS_FILE, CredentialStore } from './store.ts';
import { hasPlanScope } from './oauth.ts';
import { COMPANION_VERSION } from './version.ts';

export interface DoctorOptions {
  platform: Platform;
  hostScript: string;
  /** Defaults to companionHome(). */
  companionHome?: string;
  fetch?: FetchFn;
}

const mode = (m: number) => `0${(m & 0o777).toString(8)}`;

export async function doctor(o: DoctorOptions): Promise<string[]> {
  const lines: string[] = [];
  const ok = (s: string) => lines.push(`  ok    ${s}`);
  const warn = (s: string) => lines.push(`  warn  ${s}`);
  const info = (s: string) => lines.push(`        ${s}`);

  lines.push(`GrammarMe ChatGPT companion ${COMPANION_VERSION}`);
  const [major = 0, minor = 0] = process.versions.node.split('.').map(Number);
  if (major > 22 || (major === 22 && minor >= 6)) ok(`Node ${process.versions.node} (${process.execPath})`);
  else warn(`Node ${process.versions.node}: version 22.6 or newer is required`);

  if (o.platform.os === 'win32') warn('Windows isn’t supported yet.');

  lines.push('Launcher');
  const launcher = join(installDir(o.companionHome ?? companionHome()), LAUNCHER_NAME);
  const standalone = join(installDir(o.companionHome ?? companionHome()), INSTALLED_BINARY_NAME);
  if (await isExecutable(standalone)) {
    ok(`${standalone} (standalone; no Node needed)`);
  } else if (await isExecutable(launcher)) {
    ok(launcher);
    const nodePath = nodePathFromLauncher(await readFile(launcher, 'utf8'));
    if (nodePath && (await isExecutable(nodePath))) ok(`runs Node at ${nodePath}`);
    else warn(`its Node binary (${nodePath ?? 'unknown'}) is missing — run \`grammarme-companion install\` again`);
  } else {
    warn(`not installed (${launcher}) — run \`grammarme-companion install\``);
  }

  lines.push('Native messaging manifests');
  const data = browserDataDirs(o.platform);
  let found = 0;
  for (const browser of BROWSERS) {
    if (!data) break;
    const file = join(data[browser], 'NativeMessagingHosts', MANIFEST_FILE);
    let text: string;
    try {
      text = await readFile(file, 'utf8');
    } catch {
      continue;
    }
    found++;
    try {
      const m = JSON.parse(text) as { name?: unknown; path?: unknown; allowed_origins?: unknown };
      const origins = Array.isArray(m.allowed_origins) ? m.allowed_origins.join(', ') : 'none';
      if (m.name !== COMPANION_HOST) warn(`${browser}: ${file} has an unexpected name`);
      else if (typeof m.path === 'string' && (await isExecutable(m.path))) ok(`${browser}: ${file}`);
      else warn(`${browser}: ${file} points to a missing launcher (${String(m.path)}) — run install again`);
      info(`allowed origins: ${origins}`);
    } catch {
      warn(`${browser}: ${file} is not valid JSON`);
    }
  }
  if (found === 0) warn('no manifest installed for Chrome, Chromium, Edge or Brave');

  const home = companionHome(o.platform.env);
  lines.push('Companion data');
  info(`folder: ${home}`);
  info(`allowed extension IDs: ${(await loadAllowedExtensionIds(home)).join(', ')}`);
  try {
    const dirMode = (await stat(home)).mode;
    if ((dirMode & 0o077) === 0 || o.platform.os === 'win32') ok(`folder permissions ${mode(dirMode)}`);
    else warn(`folder permissions ${mode(dirMode)} (expected 0700)`);
  } catch {
    info('folder not created yet');
  }
  const credFile = join(home, CREDENTIALS_FILE);
  try {
    const fileMode = (await stat(credFile)).mode;
    if ((fileMode & 0o077) === 0 || o.platform.os === 'win32') ok(`${CREDENTIALS_FILE} permissions ${mode(fileMode)}`);
    else warn(`${CREDENTIALS_FILE} permissions ${mode(fileMode)} (expected 0600)`);
    const cur = await new CredentialStore(home).read();
    if (cur.tokens) {
      ok(`connected${cur.profile?.email ? ` as ${cur.profile.email}` : ''}; plan usage ${hasPlanScope(cur.tokens.scope) ? 'allowed' : 'NOT granted'}`);
    } else {
      info('not connected');
    }
  } catch {
    info(`${CREDENTIALS_FILE}: none (not connected)`);
  }

  lines.push('OpenAI');
  try {
    const endpoints = resolveEndpoints(o.platform.env);
    const res = await getJson(o.fetch ?? fetch, `${endpoints.authOrigin}/.well-known/openid-configuration`, AbortSignal.timeout(8_000));
    if (res.status === 200) ok(`sign-in discovery reachable (${endpoints.authOrigin})`);
    else warn(`sign-in discovery returned HTTP ${res.status}`);
  } catch (e) {
    warn(`sign-in discovery not reachable (${e instanceof Error ? e.message : 'error'})`);
  }
  return lines;
}
