/**
 * Registers the companion as a Chrome native messaging host for the current user (macOS, Linux).
 *
 * Copies the built single-file host into `<companion home>/bin/` (by default ~/.config/grammarme/bin),
 * writes a POSIX launcher there that execs the absolute Node binary used for the install, and writes
 * `com.grammarme.chatgpt.json` into each browser's user-level NativeMessagingHosts directory.
 *
 * Why copy: Chrome launches the host itself. If it ran from a checkout under ~/Documents, ~/Desktop
 * or ~/Downloads, macOS privacy protection could prompt for, or silently block, folder access. The
 * bundle has no dependencies, so the copy runs on its own. Windows needs registry keys and isn't
 * supported yet.
 */
import { access, chmod, copyFile, mkdir, readFile, rename, rm, rmdir, stat, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { COMPANION_HOST } from '@grammarme/core/companion';
import { DEFAULT_EXTENSION_ID } from './config.ts';
import { ALLOWED_ORIGINS_FILE, extensionOrigin, isValidExtensionId, saveAllowedExtensionIds } from './origin.ts';

export const BROWSERS = ['chrome', 'chromium', 'edge', 'brave'] as const;
export type Browser = (typeof BROWSERS)[number];
export const LAUNCHER_NAME = 'grammarme-companion-host.sh';
export const INSTALLED_HOST_NAME = 'grammarme-companion.mjs';
/** The standalone executable's name once installed (it is its own launcher). */
export const INSTALLED_BINARY_NAME = 'grammarme-companion';

/** Where install puts the launcher and its copy of the host. */
export function installDir(companionHome: string): string {
  return join(companionHome, 'bin');
}
export const MANIFEST_FILE = `${COMPANION_HOST}.json`;

export interface Platform {
  os: NodeJS.Platform;
  homeDir: string;
  env: NodeJS.ProcessEnv;
}

/** Each browser's user data directory (the parent of NativeMessagingHosts). */
export function browserDataDirs(p: Platform): Record<Browser, string> | null {
  if (p.os === 'darwin') {
    const base = join(p.homeDir, 'Library', 'Application Support');
    return {
      chrome: join(base, 'Google', 'Chrome'),
      chromium: join(base, 'Chromium'),
      edge: join(base, 'Microsoft Edge'),
      brave: join(base, 'BraveSoftware', 'Brave-Browser'),
    };
  }
  if (p.os === 'linux' || p.os === 'freebsd' || p.os === 'openbsd') {
    const xdg = p.env.XDG_CONFIG_HOME;
    const base = xdg && isAbsolute(xdg) ? xdg : join(p.homeDir, '.config');
    return {
      chrome: join(base, 'google-chrome'),
      chromium: join(base, 'chromium'),
      edge: join(base, 'microsoft-edge'),
      brave: join(base, 'BraveSoftware', 'Brave-Browser'),
    };
  }
  return null;
}

/** POSIX single-quote quoting: safe for any path, including spaces and quotes. */
export function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function launcherScript(nodePath: string, hostScript: string): string {
  return [
    '#!/bin/sh',
    '# GrammarMe ChatGPT companion launcher, written by `grammarme-companion install`.',
    '# Chrome starts this for the GrammarMe extension. Re-run install if Node or GrammarMe moves.',
    `exec ${shQuote(nodePath)} ${shQuote(hostScript)} "$@"`,
    '',
  ].join('\n');
}

export function hostManifest(launcherPath: string, extensionIds: readonly string[]): Record<string, unknown> {
  return {
    name: COMPANION_HOST,
    description: 'GrammarMe ChatGPT companion',
    path: launcherPath,
    type: 'stdio',
    allowed_origins: extensionIds.map(extensionOrigin),
  };
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export interface InstallOptions {
  platform: Platform;
  /** Absolute path of the built host (dist/grammarme-companion.mjs). */
  hostScript: string;
  /** Absolute Node binary (process.execPath). */
  nodePath: string;
  /**
   * `hostScript` is a standalone executable (Node single executable application). It is copied as
   * is and Chrome runs it directly; no Node or launcher script is involved.
   */
  standalone?: boolean;
  extensionIds: readonly string[];
  /** Explicit browsers ('all' = every known one). Default: those whose data directory exists. */
  browsers?: readonly Browser[];
  /** Extra NativeMessagingHosts directories (tests, temporary Chrome profiles). */
  manifestDirs?: readonly string[];
  /** Companion home, for allowed-origins.json. */
  companionHome: string;
}

export interface InstallResult {
  launcher: string;
  manifests: string[];
  extensionIds: string[];
}

export class InstallError extends Error {}

export async function targetManifestDirs(
  platform: Platform,
  browsers: readonly Browser[] | undefined,
  manifestDirs: readonly string[] | undefined,
  forUninstall = false,
): Promise<string[]> {
  const dirs = new Set((manifestDirs ?? []).map((d) => d));
  const data = browserDataDirs(platform);
  if (!data) throw new InstallError('Installing the companion on this operating system isn’t supported yet (macOS and Linux only).');
  if (browsers?.length) {
    for (const b of browsers) dirs.add(join(data[b], 'NativeMessagingHosts'));
  } else if (forUninstall || !manifestDirs?.length) {
    for (const b of BROWSERS) {
      if (forUninstall || (await exists(data[b]))) dirs.add(join(data[b], 'NativeMessagingHosts'));
    }
  }
  return [...dirs];
}

export async function install(o: InstallOptions): Promise<InstallResult> {
  if (o.platform.os === 'win32') {
    throw new InstallError('Windows isn’t supported yet: native messaging hosts there are registered in the registry. See apps/companion/README.md.');
  }
  if (!isAbsolute(o.hostScript) || !isAbsolute(o.nodePath)) throw new InstallError('Host script and Node paths must be absolute.');
  if (!(await exists(o.hostScript))) throw new InstallError(`The companion isn’t built yet (${o.hostScript} is missing). Run npm run build -w apps/companion.`);
  for (const id of o.extensionIds) if (!isValidExtensionId(id)) throw new InstallError(`Not a Chrome extension ID: ${id}`);

  const dirs = await targetManifestDirs(o.platform, o.browsers, o.manifestDirs);
  if (dirs.length === 0) {
    throw new InstallError('No Chrome, Chromium, Edge or Brave profile found. Pass --browser chrome (or another browser) or --manifest-dir <dir>.');
  }

  const ids = await saveAllowedExtensionIds(o.companionHome, [DEFAULT_EXTENSION_ID, ...o.extensionIds]);
  // The manifest lists only the IDs asked for in this install (plus the published extension).
  const manifestIds = [...new Set([DEFAULT_EXTENSION_ID, ...o.extensionIds])];

  const bin = installDir(o.companionHome);
  await mkdir(bin, { recursive: true, mode: 0o700 });
  let launcher: string;
  if (o.standalone) {
    launcher = join(bin, INSTALLED_BINARY_NAME);
    if (resolve(o.hostScript) !== resolve(launcher)) {
      // Copy to a temporary name first: replacing a running executable in place can crash it.
      const tmp = `${launcher}.new`;
      await copyFile(o.hostScript, tmp);
      await chmod(tmp, 0o755);
      await rename(tmp, launcher);
    }
    // A Node-mode install from before would otherwise linger and confuse doctor.
    await rm(join(bin, LAUNCHER_NAME), { force: true });
    await rm(join(bin, INSTALLED_HOST_NAME), { force: true });
  } else {
    const hostCopy = join(bin, INSTALLED_HOST_NAME);
    await copyFile(o.hostScript, hostCopy);
    await chmod(hostCopy, 0o644);
    launcher = join(bin, LAUNCHER_NAME);
    await writeFile(launcher, launcherScript(o.nodePath, hostCopy), { mode: 0o755 });
    await chmod(launcher, 0o755);
    await rm(join(bin, INSTALLED_BINARY_NAME), { force: true });
  }

  const manifests: string[] = [];
  const body = `${JSON.stringify(hostManifest(launcher, manifestIds), null, 2)}\n`;
  for (const dir of dirs) {
    await mkdir(dir, { recursive: true });
    const file = join(dir, MANIFEST_FILE);
    await writeFile(file, body, { mode: 0o644 });
    await chmod(file, 0o644);
    manifests.push(file);
  }
  return { launcher, manifests, extensionIds: ids };
}

export interface UninstallOptions {
  platform: Platform;
  hostScript: string;
  manifestDirs?: readonly string[];
  companionHome: string;
}

/**
 * Removes our manifests (only files that name our host). With `manifestDirs`, only those folders are
 * touched (a temporary profile's cleanup must not uninstall the real setup); otherwise every known
 * browser folder is cleaned and the launcher and allow list are removed too.
 */
export async function uninstall(o: UninstallOptions): Promise<string[]> {
  const removed: string[] = [];
  const scoped = Boolean(o.manifestDirs?.length);
  const dirs = scoped ? [...(o.manifestDirs ?? [])] : await targetManifestDirs(o.platform, undefined, undefined, true);
  for (const dir of dirs) {
    const file = join(dir, MANIFEST_FILE);
    try {
      const parsed = JSON.parse(await readFile(file, 'utf8')) as { name?: unknown };
      if (parsed.name !== COMPANION_HOST) continue;
      await rm(file);
      removed.push(file);
    } catch {
      // Not there.
    }
  }
  if (scoped) return removed;
  const bin = installDir(o.companionHome);
  for (const f of [join(bin, LAUNCHER_NAME), join(bin, INSTALLED_HOST_NAME), join(bin, INSTALLED_BINARY_NAME)]) {
    if (await exists(f)) {
      await rm(f);
      removed.push(f);
    }
  }
  await rmdir(bin).catch(() => undefined); // only if now empty
  const allowList = join(o.companionHome, ALLOWED_ORIGINS_FILE);
  if (await exists(allowList)) {
    await rm(allowList);
    removed.push(allowList);
  }
  return removed;
}

/** Node path baked into a launcher, for doctor. */
export function nodePathFromLauncher(script: string): string | null {
  const m = /^exec '((?:[^']|'\\'')*)'/m.exec(script);
  return m?.[1] ? m[1].replace(/'\\''/g, "'") : null;
}

export async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}
