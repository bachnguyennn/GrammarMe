/**
 * grammarme-companion: the native messaging host (when Chrome starts it with an extension origin)
 * and a small CLI for installing and managing it.
 */
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { COMPANION_ERROR_TEXT } from '@grammarme/core/companion';
import { Companion, openInBrowser } from './companion.ts';
import { companionHome } from './config.ts';
import { doctor } from './doctor.ts';
import { CompanionError } from './errors.ts';
import { runHost } from './host.ts';
import { BROWSERS, install, InstallError, uninstall } from './install.ts';
import type { Browser, Platform } from './install.ts';
import { logEvent } from './log.ts';
import { isAllowedOrigin, loadAllowedExtensionIds } from './origin.ts';
import { COMPANION_VERSION } from './version.ts';

const USAGE = `grammarme-companion ${COMPANION_VERSION}

Usage:
  grammarme-companion install [--extension-id <id>]... [--browser chrome|chromium|edge|brave|all]... [--manifest-dir <dir>]...
  grammarme-companion uninstall [--manifest-dir <dir>]...
  grammarme-companion doctor
  grammarme-companion status
  grammarme-companion sign-in
  grammarme-companion sign-out
  grammarme-companion --version

Chrome starts the companion itself (with the extension's origin as the argument) when GrammarMe
needs it, and it exits when the extension disconnects.`;

const HOST_SCRIPT = fileURLToPath(import.meta.url);

function platform(): Platform {
  return { os: process.platform, homeDir: homedir(), env: process.env };
}

function parseFlags(args: string[]): { ids: string[]; browsers: Browser[]; dirs: string[] } {
  const ids: string[] = [];
  const browsers = new Set<Browser>();
  const dirs: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    const value = args[i + 1];
    if (flag !== '--extension-id' && flag !== '--browser' && flag !== '--manifest-dir') throw new InstallError(`Unknown option: ${flag}`);
    if (!value || value.startsWith('--')) throw new InstallError(`${flag} needs a value.`);
    i++;
    if (flag === '--extension-id') ids.push(value);
    else if (flag === '--manifest-dir') dirs.push(value);
    else if (value === 'all') BROWSERS.forEach((b) => browsers.add(b));
    else if ((BROWSERS as readonly string[]).includes(value)) browsers.add(value as Browser);
    else throw new InstallError(`Unknown browser: ${value} (use chrome, chromium, edge, brave or all).`);
  }
  return { ids, browsers: [...browsers], dirs: dirs.map((d) => (d.startsWith('/') ? d : `${process.cwd()}/${d}`)) };
}

async function hostMode(origin: string): Promise<number> {
  // stdout is the native messaging channel: route any stray console output to stderr.
  console.log = console.error;
  console.info = console.error;
  const home = companionHome();
  if (!isAllowedOrigin(origin, await loadAllowedExtensionIds(home))) {
    logEvent('refused_origin');
    return 1;
  }
  let companion: Companion;
  try {
    companion = new Companion({ home });
  } catch (e) {
    logEvent('config_error', { message: e instanceof Error ? e.message : 'unknown' });
    return 1;
  }
  await runHost(companion, { input: process.stdin, output: process.stdout });
  return 0;
}

function describeError(e: unknown): string {
  return e instanceof CompanionError ? `${e.message} (${e.code})` : e instanceof Error ? e.message : COMPANION_ERROR_TEXT.internal;
}

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  if (cmd?.startsWith('chrome-extension://')) return hostMode(cmd);

  switch (cmd) {
    case 'install': {
      const flags = parseFlags(rest);
      if (process.platform === 'win32') {
        console.error('Windows isn’t supported yet. See apps/companion/README.md.');
        return 1;
      }
      const result = await install({
        platform: platform(),
        hostScript: HOST_SCRIPT,
        nodePath: process.execPath,
        extensionIds: flags.ids,
        ...(flags.browsers.length ? { browsers: flags.browsers } : {}),
        ...(flags.dirs.length ? { manifestDirs: flags.dirs } : {}),
        companionHome: companionHome(),
      });
      console.log(`Launcher: ${result.launcher}`);
      for (const m of result.manifests) console.log(`Manifest: ${m}`);
      console.log(`Allowed extension IDs: ${result.extensionIds.join(', ')}`);
      console.log('Done. Reload the GrammarMe extension, then choose Continue with ChatGPT.');
      return 0;
    }
    case 'uninstall': {
      const flags = parseFlags(rest);
      const removed = await uninstall({
        platform: platform(),
        hostScript: HOST_SCRIPT,
        ...(flags.dirs.length ? { manifestDirs: flags.dirs } : {}),
        companionHome: companionHome(),
      });
      for (const f of removed) console.log(`Removed ${f}`);
      if (!removed.length) console.log('Nothing to remove.');
      console.log('ChatGPT credentials were kept; run `grammarme-companion sign-out` first to remove them.');
      return 0;
    }
    case 'doctor':
      for (const line of await doctor({ platform: platform(), hostScript: HOST_SCRIPT })) console.log(line);
      return 0;
    case 'status': {
      const s = await new Companion({ home: companionHome() }).status();
      console.log(`Connected: ${s.connected ? 'yes' : 'no'}`);
      if (s.account) {
        console.log(`Account: ${s.account.email ?? s.account.name ?? '(no email shared)'}`);
        console.log(`Plan usage permission: ${s.account.planUsage ? 'yes' : 'no'}`);
      }
      console.log(`Model: ${s.model ?? '(not chosen yet)'}`);
      return 0;
    }
    case 'sign-in': {
      const companion = new Companion({ home: companionHome(), openBrowser: openInBrowser });
      const s = await companion.signIn((url) => console.log(`Open this page to connect ChatGPT:\n${url}`), new AbortController().signal);
      console.log(`Connected${s.account?.email ? ` as ${s.account.email}` : ''}.`);
      return 0;
    }
    case 'sign-out': {
      const { revoked } = await new Companion({ home: companionHome() }).signOut();
      console.log(revoked ? 'Signed out. OpenAI confirmed the session was revoked.' : 'Signed out locally. OpenAI didn’t confirm revocation; you can also disconnect GrammarMe in ChatGPT settings.');
      return 0;
    }
    case '--version':
    case 'version':
      console.log(COMPANION_VERSION);
      return 0;
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      console.log(USAGE);
      return cmd === undefined ? 1 : 0;
    default:
      console.error(`Unknown command: ${cmd}\n\n${USAGE}`);
      return 1;
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
    // In host mode, exit once replies are flushed even if a socket or timer is still open.
    if (process.argv[2]?.startsWith('chrome-extension://')) process.stdout.write('', () => process.exit(code));
  },
  (e: unknown) => {
    if (process.argv[2]?.startsWith('chrome-extension://')) logEvent('fatal', { name: e instanceof Error ? e.name : 'unknown' });
    else console.error(describeError(e));
    process.exit(1);
  },
);

