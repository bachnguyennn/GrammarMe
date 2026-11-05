import { afterEach, describe, expect, it } from 'vitest';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { DEFAULT_EXTENSION_ID } from '../src/config.ts';
import { ALLOWED_ORIGINS_FILE, extensionIdFromOrigin, isAllowedOrigin, loadAllowedExtensionIds, saveAllowedExtensionIds } from '../src/origin.ts';
import { cleanupHomes, tempHome } from './helpers.ts';

const OTHER = 'abcdefghijklmnopabcdefghijklmnop';

afterEach(cleanupHomes);

describe('caller origin check', () => {
  it('accepts the published extension origin as Chrome passes it', () => {
    expect(isAllowedOrigin(`chrome-extension://${DEFAULT_EXTENSION_ID}/`, [DEFAULT_EXTENSION_ID])).toBe(true);
    expect(isAllowedOrigin(`chrome-extension://${DEFAULT_EXTENSION_ID}`, [DEFAULT_EXTENSION_ID])).toBe(true);
  });

  it('refuses other extensions, web origins and malformed input', () => {
    expect(isAllowedOrigin(`chrome-extension://${OTHER}/`, [DEFAULT_EXTENSION_ID])).toBe(false);
    expect(isAllowedOrigin('https://evil.example/', [DEFAULT_EXTENSION_ID])).toBe(false);
    expect(isAllowedOrigin(`chrome-extension://${DEFAULT_EXTENSION_ID}/x`, [DEFAULT_EXTENSION_ID])).toBe(false);
    expect(isAllowedOrigin(`chrome-extension://${DEFAULT_EXTENSION_ID.toUpperCase()}/`, [DEFAULT_EXTENSION_ID])).toBe(false);
    expect(isAllowedOrigin(undefined, [DEFAULT_EXTENSION_ID])).toBe(false);
    expect(isAllowedOrigin('', [DEFAULT_EXTENSION_ID])).toBe(false);
    expect(extensionIdFromOrigin('chrome-extension://zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz/')).toBeNull();
  });

  it('loads extra IDs from allowed-origins.json, merging on save', async () => {
    const home = await tempHome();
    expect(await loadAllowedExtensionIds(home)).toEqual([DEFAULT_EXTENSION_ID]);
    await saveAllowedExtensionIds(home, [OTHER, 'not-an-id']);
    await saveAllowedExtensionIds(home, []);
    const ids = await loadAllowedExtensionIds(home);
    expect(ids).toEqual([DEFAULT_EXTENSION_ID, OTHER]);
    expect(isAllowedOrigin(`chrome-extension://${OTHER}/`, ids)).toBe(true);
    if (process.platform !== 'win32') expect((await stat(join(home, ALLOWED_ORIGINS_FILE))).mode & 0o777).toBe(0o600);
  });
});
