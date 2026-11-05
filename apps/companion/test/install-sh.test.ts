/**
 * The one-line installer (install.sh) against a local fake "release": the right download for the
 * machine, checksum enforcement, and refusal of non-HTTPS download addresses. The fake companion
 * just records the arguments it was installed with.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const INSTALLER = join(dirname(fileURLToPath(import.meta.url)), '..', 'install.sh');
const posix = process.platform === 'darwin' || process.platform === 'linux';
const os = process.platform === 'darwin' ? 'darwin' : 'linux';
const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
const BIN = `grammarme-companion-${os}-${arch}`;

let root: string;
let server: Server;
let base: string;
const files = new Map<string, Buffer>();
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

function writeSums(tamper?: string) {
  const lines = [...files].filter(([n]) => n !== 'SHA256SUMS').map(([n, b]) => `${n === tamper ? '0'.repeat(64) : sha(b)}  ${n}`);
  files.set('SHA256SUMS', Buffer.from(`${lines.join('\n')}\n`));
}

/** Run install.sh like `curl … | sh`, with a PATH that does or doesn't contain node. */
function runInstaller(env: Record<string, string>, withNode: boolean): Promise<{ code: number; out: string }> {
  const binDir = join(root, withNode ? 'path-node' : 'path-nonode');
  if (!existsSync(binDir)) {
    mkdirSync(binDir);
    const tools = ['sh', 'curl', 'awk', 'tar', 'gzip', 'mktemp', 'uname', 'chmod', 'rm', 'cat', 'printf', 'shasum', 'sha256sum', 'perl'];
    for (const t of tools) {
      try {
        const p = execFileSync('/bin/sh', ['-c', `command -v ${t}`], { encoding: 'utf8' }).trim();
        if (p.startsWith('/')) symlinkSync(p, join(binDir, t));
      } catch {
        /* not on this system */
      }
    }
    if (withNode) symlinkSync(process.execPath, join(binDir, 'node'));
  }
  return new Promise((resolve) => {
    const child = spawn('/bin/sh', ['-s', '--', '--browser', 'chrome'], {
      env: { HOME: join(root, 'home'), PATH: binDir, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('close', (code) => resolve({ code: code ?? -1, out }));
    child.stdin.end(readFileSync(INSTALLER));
  });
}

beforeAll(async () => {
  if (!posix) return;
  root = mkdtempSync(join(tmpdir(), 'gm-install-sh-'));
  // The fake companion records how it was run.
  const record = (label: string) => `writeFileSync(process.env.GM_RECORD, JSON.stringify({ via: '${label}', args: process.argv.slice(2) }))`;
  files.set('grammarme-companion.mjs', Buffer.from(`import { writeFileSync } from 'node:fs';\n${record('node')};\n`));
  const stage = join(root, 'stage');
  mkdirSync(stage);
  writeFileSync(join(stage, BIN), `#!/bin/sh\nprintf '{"via":"standalone","args":["%s","%s","%s"]}' "$1" "$2" "$3" > "$GM_RECORD"\n`, { mode: 0o755 });
  execFileSync('tar', ['-czf', join(root, `${BIN}.tar.gz`), '-C', stage, BIN]);
  files.set(`${BIN}.tar.gz`, readFileSync(join(root, `${BIN}.tar.gz`)));
  writeSums();
  server = createServer((req, res) => {
    const body = files.get((req.url ?? '/').slice(1));
    if (!body) {
      res.writeHead(404);
      return res.end();
    }
    res.writeHead(200);
    res.end(body);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});

afterAll(() => {
  server?.close();
  if (root) rmSync(root, { recursive: true, force: true });
});

const record = () => JSON.parse(readFileSync(join(root, 'record.json'), 'utf8')) as { via: string; args: string[] };

describe.skipIf(!posix)('install.sh', () => {
  it('uses the small Node download when Node 22.6+ is present, and passes arguments to install', async () => {
    writeSums();
    const r = await runInstaller({ GRAMMARME_DOWNLOAD_BASE: base, GM_RECORD: join(root, 'record.json') }, true);
    expect(r.out).toContain('Using your Node.js');
    expect(r.code).toBe(0);
    expect(record()).toEqual({ via: 'node', args: ['install', '--browser', 'chrome'] });
  });

  it('downloads the standalone build when Node is missing', async () => {
    writeSums();
    rmSync(join(root, 'record.json'), { force: true });
    const r = await runInstaller({ GRAMMARME_DOWNLOAD_BASE: base, GM_RECORD: join(root, 'record.json') }, false);
    expect(r.out).toContain('standalone companion');
    expect(r.code).toBe(0);
    expect(record()).toEqual({ via: 'standalone', args: ['install', '--browser', 'chrome'] });
  });

  it('refuses a download whose checksum does not match, and installs nothing', async () => {
    writeSums(`${BIN}.tar.gz`);
    rmSync(join(root, 'record.json'), { force: true });
    const r = await runInstaller({ GRAMMARME_DOWNLOAD_BASE: base, GM_RECORD: join(root, 'record.json') }, false);
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("doesn't match its checksum");
    expect(existsSync(join(root, 'record.json'))).toBe(false);
  });

  it('refuses plain-HTTP download addresses other than 127.0.0.1', async () => {
    const r = await runInstaller({ GRAMMARME_DOWNLOAD_BASE: 'http://example.com/x' }, true);
    expect(r.code).not.toBe(0);
    expect(r.out).toContain('must be an https:// address');
  });

  it('explains what to do when there is no published release yet', async () => {
    const r = await runInstaller({ GRAMMARME_DOWNLOAD_BASE: `${base}/missing` }, true);
    expect(r.code).not.toBe(0);
    expect(r.out).toContain('published release');
  });
});
