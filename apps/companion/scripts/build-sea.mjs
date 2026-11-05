// Builds the standalone companion: one executable with Node built in, for people without Node.
// Uses Node's official single executable application (SEA) support:
//   https://nodejs.org/api/single-executable-applications.html
//
//   node build.mjs && node scripts/build-sea.mjs
//
// Writes dist/grammarme-companion-<os>-<arch> and a .tar.gz of it. Build it with the Node version
// you want to ship (CI pins Node 22). macOS builds are ad-hoc signed so they run on Apple silicon.
import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
const main = join(dist, 'grammarme-companion.cjs');
if (!existsSync(main)) throw new Error('Run `node build.mjs` first.');

const os = process.platform === 'darwin' ? 'darwin' : process.platform === 'linux' ? 'linux' : null;
if (!os) throw new Error(`Standalone builds are made on macOS or Linux, not ${process.platform}.`);
const arch = process.arch === 'arm64' ? 'arm64' : process.arch === 'x64' ? 'x64' : null;
if (!arch) throw new Error(`Unsupported architecture ${process.arch}.`);

const name = `grammarme-companion-${os}-${arch}`;
const exe = join(dist, name);
const blob = join(dist, 'sea-prep.blob');
const config = join(dist, 'sea-config.json');
const run = (cmd, args) => execFileSync(cmd, args, { stdio: 'inherit', cwd: dist });

writeFileSync(config, JSON.stringify({ main, output: blob, disableExperimentalSEAWarning: true, useSnapshot: false, useCodeCache: false }));
run(process.execPath, ['--experimental-sea-config', config]);

rmSync(exe, { force: true });
copyFileSync(process.execPath, exe);
chmodSync(exe, 0o755);
if (os === 'darwin') run('codesign', ['--remove-signature', exe]);
const postject = join(root, '..', '..', 'node_modules', 'postject', 'dist', 'cli.js');
run(process.execPath, [
  postject,
  exe,
  'NODE_SEA_BLOB',
  blob,
  '--sentinel-fuse',
  'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
  ...(os === 'darwin' ? ['--macho-segment-name', 'NODE_SEA'] : []),
]);
if (os === 'darwin') run('codesign', ['--sign', '-', exe]);

const version = execFileSync(exe, ['--version'], { encoding: 'utf8' }).trim();
run('tar', ['-czf', `${name}.tar.gz`, name]);
rmSync(blob, { force: true });
rmSync(config, { force: true });
console.log(`Built ${exe} (companion ${version}, Node ${process.versions.node}) and ${name}.tar.gz`);
