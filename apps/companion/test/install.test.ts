import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { doctor } from '../src/doctor.ts';
import { browserDataDirs, install, InstallError, launcherScript, MANIFEST_FILE, nodePathFromLauncher, shQuote, uninstall } from '../src/install.ts';
import type { Platform } from '../src/install.ts';
import { loadAllowedExtensionIds } from '../src/origin.ts';
import { CredentialStore } from '../src/store.ts';
import { cleanupHomes, connectedFile, json, mockFetch, tempHome } from './helpers.ts';

afterEach(cleanupHomes);
const posix = process.platform !== 'win32';
const EXTRA_ID = 'abcdefghijklmnopabcdefghijklmnop';

/** A fake home with a built host inside a directory whose name has spaces and a quote. */
async function setup(os: NodeJS.Platform = 'darwin') {
  const root = await tempHome();
  const homeDir = join(root, 'home');
  const distDir = join(root, "My Projects/Bach's GrammarMe/dist");
  await mkdir(distDir, { recursive: true });
  const hostScript = join(distDir, 'grammarme-companion.mjs');
  await writeFile(hostScript, 'process.stdout.write(JSON.stringify(process.argv.slice(2)));\n');
  const companionHome = join(root, 'cfg');
  const platform: Platform = { os, homeDir, env: { GRAMMARME_COMPANION_HOME: companionHome } };
  return { root, homeDir, hostScript, companionHome, platform };
}

describe('launcher', () => {
  it('quotes paths for sh, including spaces and single quotes', () => {
    expect(shQuote("/a b/c'd")).toBe(`'/a b/c'\\''d'`);
    const script = launcherScript('/opt/node 22/bin/node', "/x/Bach's dir/host.mjs");
    expect(script.startsWith('#!/bin/sh\n')).toBe(true);
    expect(nodePathFromLauncher(script)).toBe('/opt/node 22/bin/node');
  });

  it.skipIf(!posix)('runs the host with Node and forwards Chrome’s arguments', async () => {
    const s = await setup(process.platform);
    const r = await install({ ...s, platform: { ...s.platform, os: 'darwin' }, nodePath: process.execPath, extensionIds: [], manifestDirs: [join(s.root, 'nmh')] });
    expect((await stat(r.launcher)).mode & 0o777).toBe(0o755);
    const run = spawnSync(r.launcher, ['chrome-extension://cflaepodgccnfddlhomomhbmhgkgikhf/', '--parent-window=0'], { encoding: 'utf8' });
    expect(run.status).toBe(0);
    expect(JSON.parse(run.stdout)).toEqual(['chrome-extension://cflaepodgccnfddlhomomhbmhgkgikhf/', '--parent-window=0']);
  });
});

describe('install', () => {
  it('runs a copy of the host from the companion folder, not from the checkout (macOS folder privacy)', async () => {
    const s = await setup('darwin');
    const r = await install({ ...s, nodePath: process.execPath, extensionIds: [], manifestDirs: [join(s.root, 'nmh')] });
    expect(r.launcher.startsWith(join(s.companionHome, 'bin'))).toBe(true);
    const launcher = await readFile(r.launcher, 'utf8');
    expect(launcher).toContain(join(s.companionHome, 'bin', 'grammarme-companion.mjs'));
    expect(launcher).not.toContain(s.hostScript);
  });

  it('writes the host manifest into detected browsers only', async () => {
    const s = await setup('darwin');
    const dirs = browserDataDirs(s.platform)!;
    await mkdir(dirs.chrome, { recursive: true });
    await mkdir(dirs.brave, { recursive: true });
    const r = await install({ ...s, nodePath: process.execPath, extensionIds: [EXTRA_ID] });
    expect(r.manifests.sort()).toEqual([join(dirs.brave, 'NativeMessagingHosts', MANIFEST_FILE), join(dirs.chrome, 'NativeMessagingHosts', MANIFEST_FILE)].sort());
    const manifest = JSON.parse(await readFile(r.manifests[0]!, 'utf8'));
    expect(manifest).toEqual({
      name: 'com.grammarme.chatgpt',
      description: 'GrammarMe ChatGPT companion',
      path: r.launcher,
      type: 'stdio',
      allowed_origins: ['chrome-extension://cflaepodgccnfddlhomomhbmhgkgikhf/', `chrome-extension://${EXTRA_ID}/`],
    });
    expect(manifest.path.startsWith('/')).toBe(true);
    expect(await loadAllowedExtensionIds(s.companionHome)).toContain(EXTRA_ID);
  });

  it('uses Linux browser folders', async () => {
    const s = await setup('linux');
    expect(browserDataDirs(s.platform)!.chrome).toBe(join(s.homeDir, '.config', 'google-chrome'));
    expect(browserDataDirs({ ...s.platform, env: { XDG_CONFIG_HOME: '/xdg' } })!.edge).toBe('/xdg/microsoft-edge');
  });

  it('installs into --browser targets even if the browser folder is missing', async () => {
    const s = await setup('linux');
    const r = await install({ ...s, nodePath: process.execPath, extensionIds: [], browsers: ['chromium'] });
    expect(r.manifests).toEqual([join(s.homeDir, '.config', 'chromium', 'NativeMessagingHosts', MANIFEST_FILE)]);
  });

  it('--manifest-dir installs only there', async () => {
    const s = await setup('darwin');
    await mkdir(browserDataDirs(s.platform)!.chrome, { recursive: true });
    const target = join(s.root, 'profile', 'NativeMessagingHosts');
    const r = await install({ ...s, nodePath: process.execPath, extensionIds: [], manifestDirs: [target] });
    expect(r.manifests).toEqual([join(target, MANIFEST_FILE)]);
  });

  it('refuses with no browser found, bad IDs, a missing build, and Windows', async () => {
    const s = await setup('darwin');
    await expect(install({ ...s, nodePath: process.execPath, extensionIds: [] })).rejects.toThrow(/--browser/);
    await expect(install({ ...s, nodePath: process.execPath, extensionIds: ['nope'], browsers: ['chrome'] })).rejects.toThrow(InstallError);
    await expect(install({ ...s, hostScript: join(s.root, 'missing.mjs'), nodePath: process.execPath, extensionIds: [], browsers: ['chrome'] })).rejects.toThrow(/isn’t built/);
    await expect(install({ ...s, platform: { ...s.platform, os: 'win32' }, nodePath: process.execPath, extensionIds: [] })).rejects.toThrow(/Windows/);
  });

  it('uninstall removes manifests, the launcher and the allow list', async () => {
    const s = await setup('darwin');
    const r = await install({ ...s, nodePath: process.execPath, extensionIds: [EXTRA_ID], browsers: ['edge', 'chrome'] });
    const removed = await uninstall(s);
    expect(removed.sort()).toEqual(
      [...r.manifests, r.launcher, join(s.companionHome, 'bin', 'grammarme-companion.mjs'), join(s.companionHome, 'allowed-origins.json')].sort(),
    );
    expect(await loadAllowedExtensionIds(s.companionHome)).toEqual(['cflaepodgccnfddlhomomhbmhgkgikhf']);
  });

  it('uninstall --manifest-dir touches only that folder', async () => {
    const s = await setup('darwin');
    const real = await install({ ...s, nodePath: process.execPath, extensionIds: [], browsers: ['chrome'] });
    const target = join(s.root, 'tmp-profile', 'NativeMessagingHosts');
    const temp = await install({ ...s, nodePath: process.execPath, extensionIds: [], manifestDirs: [target] });
    expect(await uninstall({ ...s, manifestDirs: [target] })).toEqual(temp.manifests);
    await expect(stat(real.manifests[0]!)).resolves.toBeTruthy();
    await expect(stat(real.launcher)).resolves.toBeTruthy();
  });
});

describe('doctor', () => {
  it('reports install state and credential permissions without printing tokens', async () => {
    const s = await setup('darwin');
    await mkdir(browserDataDirs(s.platform)!.chrome, { recursive: true });
    await install({ ...s, nodePath: process.execPath, extensionIds: [] });
    await new CredentialStore(s.companionHome).write(connectedFile(Date.now()));
    const m = mockFetch(() => json({ issuer: 'https://auth.openai.com' }));
    const out = (await doctor({ platform: s.platform, hostScript: s.hostScript, companionHome: s.companionHome, fetch: m.fetch })).join('\n');
    expect(out).toContain('ok    chrome:');
    expect(out).toContain(`runs Node at ${process.execPath}`);
    if (posix) expect(out).toContain('chatgpt.json permissions 0600');
    expect(out).toContain('connected as ada@example.com; plan usage allowed');
    expect(out).toContain('sign-in discovery reachable');
    expect(out).not.toMatch(/access-1|refresh-1|id-1/);
  });

  it('flags a launcher whose Node binary moved', async () => {
    const s = await setup('darwin');
    const r = await install({ ...s, nodePath: '/nonexistent/node', extensionIds: [], browsers: ['chrome'] });
    const m = mockFetch(() => {
      throw new TypeError('fetch failed');
    });
    const out = (await doctor({ platform: s.platform, hostScript: s.hostScript, companionHome: s.companionHome, fetch: m.fetch })).join('\n');
    expect(r.launcher).toBeTruthy();
    expect(out).toContain('its Node binary (/nonexistent/node) is missing');
    expect(out).toContain('not reachable');
  });
});
