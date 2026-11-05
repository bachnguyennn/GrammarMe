/** Toolbar popup: global on/off, per-site on/off, dialect, the optional ChatGPT connection, link to the web editor. */
import type { Dialect } from '@grammarme/core';
import type { GetSiteInfoRequest, SiteInfo } from './protocol.ts';
import { mountAi } from './popup-ai.ts';
import { DIALECTS, SETTINGS_KEY, normalizeSettings, siteKey, withSiteEnabled, type Settings } from './settings.ts';

/** Where the full editor lives (GitHub Pages). */
export const WEB_EDITOR_URL = 'https://bachnguyennn.github.io/GrammarMe/editor/';

const DIALECT_LABEL: Record<Dialect, string> = {
  american: 'English (US)',
  british: 'English (UK)',
  canadian: 'English (Canada)',
  australian: 'English (Australia)',
  indian: 'English (India)',
};

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} missing from popup.html`);
  return el as T;
};

async function load(): Promise<Settings> {
  const got = await chrome.storage.sync.get(SETTINGS_KEY);
  return normalizeSettings(got[SETTINGS_KEY]);
}

async function save(next: Settings): Promise<void> {
  await chrome.storage.sync.set({ [SETTINGS_KEY]: next });
}

/**
 * Ask the content script in the active tab for its hostname. This avoids the `tabs`/`activeTab`
 * permissions; it fails (null) on pages where content scripts can't run (chrome://, Web Store…).
 */
async function currentHost(): Promise<string | null> {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id === undefined) return null;
    const req: GetSiteInfoRequest = { target: 'content', type: 'getSiteInfo' };
    const info = (await chrome.tabs.sendMessage(tab.id, req)) as SiteInfo | undefined;
    return info && typeof info.host === 'string' && info.host ? info.host : null;
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const enabled = $<HTMLInputElement>('enabled');
  const site = $<HTMLInputElement>('site');
  const siteLabel = $<HTMLElement>('site-label');
  const siteNote = $<HTMLElement>('site-note');
  const dialect = $<HTMLSelectElement>('dialect');
  const editor = $<HTMLAnchorElement>('editor');

  for (const d of DIALECTS) dialect.append(new Option(DIALECT_LABEL[d], d));
  editor.href = WEB_EDITOR_URL;

  let settings = await load();
  const host = await currentHost();

  const render = () => {
    enabled.checked = settings.enabled;
    dialect.value = settings.dialect;
    if (host) {
      siteLabel.textContent = `Check on ${siteKey(host)}`;
      site.checked = !settings.disabledSites.includes(siteKey(host));
      site.disabled = !settings.enabled;
      siteNote.hidden = true;
    } else {
      siteLabel.textContent = 'This page';
      site.checked = false;
      site.disabled = true;
      siteNote.hidden = false;
    }
  };
  render();

  enabled.addEventListener('change', async () => {
    settings = { ...settings, enabled: enabled.checked };
    render();
    await save(settings);
  });
  site.addEventListener('change', async () => {
    if (!host) return;
    settings = withSiteEnabled(settings, host, site.checked);
    render();
    await save(settings);
  });
  dialect.addEventListener('change', async () => {
    settings = { ...settings, dialect: dialect.value as Dialect };
    await save(settings);
  });
}

void main();
void mountAi();
