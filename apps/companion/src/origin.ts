/**
 * Caller check. Chrome passes the calling extension's origin as the host's first argument. The
 * browser already enforces the manifest's allowed_origins; this is a second, independent check
 * against the IDs the user installed for (allowed-origins.json next to the credentials).
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DEFAULT_EXTENSION_ID } from './config.ts';
import { writeFileAtomic, ensurePrivateDir } from './store.ts';

const EXTENSION_ID = /^[a-p]{32}$/;
export const ALLOWED_ORIGINS_FILE = 'allowed-origins.json';

export function isValidExtensionId(id: string): boolean {
  return EXTENSION_ID.test(id);
}

export function extensionOrigin(id: string): string {
  return `chrome-extension://${id}/`;
}

export function extensionIdFromOrigin(origin: string): string | null {
  const m = /^chrome-extension:\/\/([a-p]{32})\/?$/.exec(origin);
  return m?.[1] ?? null;
}

export function isAllowedOrigin(origin: string | undefined, allowedIds: Iterable<string>): boolean {
  if (!origin) return false;
  const id = extensionIdFromOrigin(origin);
  if (!id) return false;
  for (const allowed of allowedIds) if (allowed === id) return true;
  return false;
}

/** The default extension ID plus any stored by `install --extension-id`. */
export async function loadAllowedExtensionIds(home: string): Promise<string[]> {
  const ids = new Set([DEFAULT_EXTENSION_ID]);
  try {
    const parsed = JSON.parse(await readFile(join(home, ALLOWED_ORIGINS_FILE), 'utf8')) as { extensionIds?: unknown };
    if (Array.isArray(parsed.extensionIds)) {
      for (const id of parsed.extensionIds) if (typeof id === 'string' && isValidExtensionId(id)) ids.add(id);
    }
  } catch {
    // Missing or unreadable: only the default ID is allowed.
  }
  return [...ids];
}

/** Adds IDs to the allow list (union, so earlier installs into other browsers keep working). */
export async function saveAllowedExtensionIds(home: string, extra: readonly string[]): Promise<string[]> {
  const ids = new Set(await loadAllowedExtensionIds(home));
  for (const id of extra) if (isValidExtensionId(id)) ids.add(id);
  await ensurePrivateDir(home);
  await writeFileAtomic(join(home, ALLOWED_ORIGINS_FILE), `${JSON.stringify({ extensionIds: [...ids] }, null, 2)}\n`);
  return [...ids];
}
