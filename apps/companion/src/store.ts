/**
 * Credential storage: one JSON file, `chatgpt.json`, in a private directory.
 *
 * - Directory mode 0700, file mode 0600 (POSIX). On Windows the default ACLs of the user's profile
 *   apply; Windows isn't a supported platform yet.
 * - Every write is atomic: a 0600 temp file in the same directory, fsync, then rename.
 * - Read-modify-write cycles hold an exclusive lock file (O_EXCL) so two companion processes (Chrome
 *   may start one per extension port) never lose each other's updates or both spend the same
 *   refresh token. A lock older than `staleLockMs` is assumed abandoned and broken.
 *
 * Nothing in this module logs file contents.
 */
import { randomBytes } from 'node:crypto';
import { chmod, mkdir, open, readFile, rename, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { CompanionError } from './errors.ts';

export const CREDENTIALS_FILE = 'chatgpt.json';
const IS_WINDOWS = process.platform === 'win32';

export interface StoredProfile {
  sub: string;
  email?: string;
  name?: string;
}

export interface StoredTokens {
  access: string;
  refresh: string;
  id: string;
  /** Epoch ms when the access token expires. */
  expiresAt: number;
  /** Space-separated granted scopes, as returned by the token endpoint. */
  scope: string;
  /** Epoch ms before which OpenAI asks us not to refresh. */
  earliestRefreshAt?: number;
}

export interface CredentialFile {
  /** Opaque per-install host identifier sent as ext_agent_host_id. Kept across sign-outs. */
  hostId?: string;
  /** The client_id OpenAI issued to this install. Kept across sign-outs. */
  clientId?: string;
  profile?: StoredProfile;
  tokens?: StoredTokens;
  model?: string;
  consentShown?: boolean;
}

export async function ensurePrivateDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  if (!IS_WINDOWS) await chmod(dir, 0o700);
}

/** Writes `data` to `file` atomically with mode 0600. */
export async function writeFileAtomic(file: string, data: string): Promise<void> {
  const tmp = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  const handle = await open(tmp, 'wx', 0o600);
  try {
    await handle.writeFile(data, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(tmp, file);
  } catch (e) {
    await unlink(tmp).catch(() => {});
    throw e;
  }
  if (!IS_WINDOWS) await chmod(file, 0o600);
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.length > 0 ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

/** Keeps only well-typed fields so a damaged file can never inject unexpected shapes. */
export function normalizeCredentials(raw: unknown): CredentialFile {
  if (!raw || typeof raw !== 'object') return {};
  const r = raw as Record<string, unknown>;
  const out: CredentialFile = {};
  if (str(r.hostId)) out.hostId = r.hostId as string;
  if (str(r.clientId)) out.clientId = r.clientId as string;
  if (str(r.model)) out.model = r.model as string;
  if (typeof r.consentShown === 'boolean') out.consentShown = r.consentShown;
  const p = r.profile as Record<string, unknown> | undefined;
  if (p && typeof p === 'object' && str(p.sub)) {
    out.profile = { sub: p.sub as string };
    if (str(p.email)) out.profile.email = p.email as string;
    if (str(p.name)) out.profile.name = p.name as string;
  }
  const t = r.tokens as Record<string, unknown> | undefined;
  if (t && typeof t === 'object' && str(t.access) && str(t.refresh) && num(t.expiresAt) !== undefined) {
    out.tokens = {
      access: t.access as string,
      refresh: t.refresh as string,
      id: str(t.id) ?? '',
      expiresAt: t.expiresAt as number,
      scope: typeof t.scope === 'string' ? t.scope : '',
    };
    const e = num(t.earliestRefreshAt);
    if (e !== undefined) out.tokens.earliestRefreshAt = e;
  }
  return out;
}

export interface StoreOptions {
  /** A lock file older than this is considered abandoned. */
  staleLockMs?: number;
  /** Give up waiting for the lock after this long. */
  lockWaitMs?: number;
}

export class CredentialStore {
  readonly dir: string;
  readonly file: string;
  readonly lockFile: string;
  private readonly staleLockMs: number;
  private readonly lockWaitMs: number;
  /** In-process queue so lock holders in this process run one at a time. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(dir: string, options: StoreOptions = {}) {
    this.dir = dir;
    this.file = join(dir, CREDENTIALS_FILE);
    this.lockFile = `${this.file}.lock`;
    this.staleLockMs = options.staleLockMs ?? 30_000;
    this.lockWaitMs = options.lockWaitMs ?? 40_000;
  }

  async read(): Promise<CredentialFile> {
    let text: string;
    try {
      text = await readFile(this.file, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return {};
      throw new CompanionError('internal', 'Couldn’t read the GrammarMe companion’s credential file.');
    }
    try {
      return normalizeCredentials(JSON.parse(text));
    } catch {
      // A damaged file holds nothing worth keeping; the next write replaces it.
      return {};
    }
  }

  /** Replaces the file. Callers doing read-modify-write must hold the lock (see `update`). */
  async write(data: CredentialFile): Promise<void> {
    try {
      await ensurePrivateDir(this.dir);
      await writeFileAtomic(this.file, `${JSON.stringify(data, null, 2)}\n`);
    } catch {
      throw new CompanionError('internal', 'Couldn’t save the GrammarMe companion’s credential file.');
    }
  }

  async update(fn: (current: CredentialFile) => CredentialFile): Promise<CredentialFile> {
    return this.withLock(async () => {
      const next = fn(await this.read());
      await this.write(next);
      return next;
    });
  }

  /** Runs `fn` while holding both the in-process queue and the cross-process lock file. */
  withLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(async () => {
      const token = await this.acquire();
      try {
        return await fn();
      } finally {
        await this.release(token);
      }
    });
    this.queue = run.catch(() => {});
    return run;
  }

  private async acquire(): Promise<string> {
    try {
      await ensurePrivateDir(this.dir);
    } catch {
      throw new CompanionError('internal', 'Couldn’t create the GrammarMe companion’s settings folder.');
    }
    const token = `${process.pid}:${randomBytes(8).toString('hex')}`;
    const deadline = Date.now() + this.lockWaitMs;
    for (;;) {
      try {
        const handle = await open(this.lockFile, 'wx', 0o600);
        try {
          await handle.writeFile(token, 'utf8');
        } finally {
          await handle.close();
        }
        return token;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') {
          throw new CompanionError('internal', 'Couldn’t lock the GrammarMe companion’s credential file.');
        }
      }
      try {
        const info = await stat(this.lockFile);
        if (Date.now() - info.mtimeMs > this.staleLockMs) {
          await unlink(this.lockFile).catch(() => {});
          continue;
        }
      } catch {
        continue; // Released between our open and stat.
      }
      if (Date.now() > deadline) {
        throw new CompanionError('internal', 'The GrammarMe companion’s credential file is locked by another process.');
      }
      await new Promise((r) => setTimeout(r, 25 + Math.random() * 50));
    }
  }

  private async release(token: string): Promise<void> {
    try {
      if ((await readFile(this.lockFile, 'utf8')) === token) await unlink(this.lockFile);
    } catch {
      // Already gone (e.g. broken as stale): nothing to do.
    }
  }
}
