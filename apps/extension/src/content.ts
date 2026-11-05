/**
 * Content script — injected into every page, but does nothing until an eligible text field is
 * focused. Top-level cost: one `focusin` listener and one runtime message listener.
 *
 * Phase 4 scope: <textarea> and <input type=text|search>. contenteditable / Google Docs are out
 * of scope (see docs/extension.md).
 */
import {
  StaleSuggestionError,
  isApplicable,
  rebaseSuggestions,
  type DocumentSnapshot,
  type Suggestion,
} from '@grammarme/core';
import { applyToField } from './apply.ts';
import { fieldEligibility } from './eligibility.ts';
import { asTextField, deepActiveElement, describeField, type TextField } from './field-dom.ts';
import { Overlay } from './overlay.ts';
import {
  CHECK_DEBOUNCE_MS,
  MAX_CHECK_CHARS,
  isCheckResponse,
  isContentRequest,
  normalizeWord,
  type AddWordRequest,
  type CheckRequest,
  type SiteInfo,
} from './protocol.ts';
import { CheckScheduler } from './scheduler.ts';
import { ignoreKey, suggestionAt, visibleSuggestions, type BadgeState } from './segments.ts';
import {
  DICTIONARY_KEY,
  SETTINGS_KEY,
  isActiveOn,
  normalizeDictionary,
  normalizeSettings,
  type Settings,
} from './settings.ts';

/** What we remember about a field between focus changes (garbage-collected with the element). */
interface FieldMemory {
  text: string;
  version: number;
  suggestions: Suggestion[];
  /** "Ignore" keys for this field, this page session only. */
  ignored: Set<string>;
}

const memory = new WeakMap<TextField, FieldMemory>();
let settings: Settings | null = null;
let dictionaryLower = new Set<string>();
let loading: Promise<void> | null = null;
let active: FieldController | null = null;
let shutDown = false;

const NAV_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown']);

function extensionAlive(): boolean {
  try {
    return !shutDown && typeof chrome !== 'undefined' && !!chrome.runtime?.id;
  } catch {
    return false;
  }
}

/** The extension was reloaded/updated: this script is orphaned, so remove everything. */
function shutdown(): void {
  shutDown = true;
  document.removeEventListener('focusin', onFocusIn, true);
  active?.destroy();
  active = null;
}

function ensureLoaded(): Promise<void> {
  loading ??= (async () => {
    const [sync, local] = await Promise.all([
      chrome.storage.sync.get(SETTINGS_KEY),
      chrome.storage.local.get(DICTIONARY_KEY),
    ]);
    settings = normalizeSettings(sync[SETTINGS_KEY]);
    dictionaryLower = new Set(normalizeDictionary(local[DICTIONARY_KEY]).map((w) => w.toLowerCase()));
    chrome.storage.onChanged.addListener(onStorageChanged);
  })();
  return loading;
}

function onStorageChanged(changes: Record<string, chrome.storage.StorageChange>, area: string): void {
  if (area === 'sync' && changes[SETTINGS_KEY]) {
    const prev = settings;
    settings = normalizeSettings(changes[SETTINGS_KEY].newValue);
    if (!isActiveOn(settings, location.hostname)) {
      active?.destroy();
      active = null;
    } else if (prev && prev.dialect !== settings.dialect) {
      active?.recheck();
    }
  }
  if (area === 'local' && changes[DICTIONARY_KEY]) {
    dictionaryLower = new Set(normalizeDictionary(changes[DICTIONARY_KEY].newValue).map((w) => w.toLowerCase()));
    active?.refresh();
  }
}

function onFocusIn(e: FocusEvent): void {
  if (!extensionAlive()) return shutdown();
  const field = asTextField(e.composedPath()[0]);
  if (!field) return;
  if (active?.field === field) return active.onRefocus();
  void activate(field);
}

async function activate(field: TextField): Promise<void> {
  try {
    await ensureLoaded();
  } catch {
    return shutdown(); // storage unavailable => extension context gone
  }
  if (!settings || !isActiveOn(settings, location.hostname)) return;
  if (!field.isConnected || deepActiveElement() !== field || active?.field === field) return;
  if (!fieldEligibility(describeField(field)).eligible) return;
  active?.destroy();
  let mem = memory.get(field);
  if (!mem) {
    mem = { text: field.value, version: 0, suggestions: [], ignored: new Set() };
    memory.set(field, mem);
  }
  active = new FieldController(field, mem);
}

type CheckOutcome = { suggestions: Suggestion[] } | { error: BadgeState };

async function requestCheck(snap: DocumentSnapshot): Promise<CheckOutcome> {
  if (!extensionAlive()) {
    queueMicrotask(shutdown);
    return { error: 'error' };
  }
  const req: CheckRequest = { target: 'background', type: 'check', text: snap.text, version: snap.version };
  let res: unknown;
  try {
    res = await chrome.runtime.sendMessage(req);
  } catch {
    if (!extensionAlive()) queueMicrotask(shutdown);
    return { error: 'error' };
  }
  if (!isCheckResponse(res) || res.version !== snap.version) return { error: 'error' };
  if (!res.ok) return { error: res.error === 'too_long' ? 'too-long' : 'error' };
  // Never trust offsets blindly: keep only suggestions that match the text we sent.
  return { suggestions: res.suggestions.filter((s) => isApplicable(snap, s)) };
}

class FieldController {
  private readonly overlay: Overlay;
  private readonly scheduler: CheckScheduler;
  private readonly resizeObserver: ResizeObserver;
  private visible: Suggestion[] = [];
  private state: BadgeState = 'idle';
  private destroyed = false;

  constructor(
    readonly field: TextField,
    private readonly mem: FieldMemory,
  ) {
    this.overlay = new Overlay(field, {
      onReplace: (s, i) => this.replace(s, i),
      onIgnore: (s) => {
        this.mem.ignored.add(ignoreKey(s));
        this.closeCard(true);
        this.refresh();
      },
      onAddWord: (s) => this.addWord(s),
      onBadgeClick: () => this.openFirst(),
      onDismiss: (returnFocus) => this.closeCard(returnFocus),
      onFieldGone: () => this.detach(),
    });
    this.scheduler = new CheckScheduler({
      delayMs: CHECK_DEBOUNCE_MS,
      current: () => ({ text: this.mem.text, version: this.mem.version }),
      // Empty text never wakes the engine (no offscreen document, no memory spent).
      shouldCheck: (snap) => snap.text.trim().length > 0 && snap.text.length <= MAX_CHECK_CHARS,
      check: async (snap) => {
        // Re-verify right before text leaves this script: pages flip fields to readonly, or a
        // "show password" toggle turns type=password into type=text while we're attached.
        if (!fieldEligibility(describeField(this.field)).eligible) {
          queueMicrotask(() => this.detach());
          return null;
        }
        const out = await requestCheck(snap);
        if ('error' in out) {
          this.state = out.error;
          this.updateBadge();
          return null;
        }
        return out.suggestions;
      },
      onResult: (snap, suggestions) => {
        if (snap.version !== this.mem.version) return;
        this.mem.suggestions = suggestions;
        this.state = snap.text.length > MAX_CHECK_CHARS ? 'too-long' : 'idle';
        this.refresh();
      },
      onBusyChange: (busy) => {
        if (busy) this.state = 'checking';
        else if (this.state === 'checking') this.state = 'idle';
        this.updateBadge();
      },
    });

    const f: HTMLElement = field; // (the union type loses addEventListener's event-map overloads)
    f.addEventListener('input', this.onInput);
    f.addEventListener('scroll', this.onScroll, { passive: true });
    f.addEventListener('mouseup', this.onMouseUp);
    f.addEventListener('keyup', this.onKeyUp);
    f.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('scroll', this.onScroll, { capture: true, passive: true });
    window.addEventListener('resize', this.onResize, { passive: true });
    this.resizeObserver = new ResizeObserver(this.onResize);
    this.resizeObserver.observe(field);

    this.syncText();
    this.refresh();
    this.scheduler.runNow();
  }

  /** Recompute what's shown from memory + ignore list + dictionary. */
  refresh(): void {
    if (this.destroyed) return;
    this.visible = visibleSuggestions(this.mem.suggestions, this.mem.ignored, dictionaryLower);
    const openId = this.overlay.cardSuggestionId;
    if (openId && !this.visible.some((s) => s.id === openId)) this.overlay.closeCard();
    this.overlay.render(this.mem.text, this.visible, this.overlay.cardSuggestionId);
    this.updateBadge();
  }

  recheck(): void {
    this.scheduler.runNow(true);
  }

  onRefocus(): void {
    if (this.syncText()) this.scheduler.schedule();
    this.overlay.scheduleLayout(true);
  }

  /** Stop being the active controller and remove all UI. */
  detach(): void {
    if (active === this) active = null;
    this.destroy();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    const f: HTMLElement = this.field;
    f.removeEventListener('input', this.onInput);
    f.removeEventListener('scroll', this.onScroll);
    f.removeEventListener('mouseup', this.onMouseUp);
    f.removeEventListener('keyup', this.onKeyUp);
    f.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('scroll', this.onScroll, { capture: true });
    window.removeEventListener('resize', this.onResize);
    this.resizeObserver.disconnect();
    this.scheduler.dispose();
    this.overlay.destroy();
  }

  private updateBadge(): void {
    if (!this.destroyed) this.overlay.setBadge(this.visible.length, this.state);
  }

  /**
   * Pull the field's value into memory. On change: bump the version and rebase underlines so they
   * stay put while the user types (the next check result replaces them).
   */
  private syncText(): boolean {
    const text = this.field.value;
    if (text === this.mem.text) return false;
    const prev = this.mem.text;
    this.mem.version += 1;
    this.mem.text = text;
    this.mem.suggestions = rebaseSuggestions(prev, { text, version: this.mem.version }, this.mem.suggestions);
    this.refresh();
    return true;
  }

  private snapshot(): DocumentSnapshot {
    return { text: this.mem.text, version: this.mem.version };
  }

  private onInput = (): void => {
    this.overlay.closeCard();
    if (this.syncText()) this.scheduler.schedule();
  };

  private onScroll = (): void => this.overlay.scheduleLayout(false);
  private onResize = (): void => this.overlay.scheduleLayout(true);

  private onMouseUp = (): void => {
    if (this.syncText()) this.scheduler.schedule();
    const { selectionStart: a, selectionEnd: b } = this.field;
    if (a === null || a !== b) return; // a real selection, not a click on a word
    const hit = suggestionAt(this.visible, a, true);
    if (hit) this.openCard(hit, false);
    else this.closeCard(false);
  };

  private onKeyUp = (e: KeyboardEvent): void => {
    if (!NAV_KEYS.has(e.key)) return;
    const { selectionStart: a, selectionEnd: b } = this.field;
    if (a === null || a !== b) return;
    const hit = suggestionAt(this.visible, a, false);
    if (hit) {
      if (hit.id !== this.overlay.cardSuggestionId) this.openCard(hit, false);
    } else {
      this.closeCard(false);
    }
  };

  private onKeyDown = (e: KeyboardEvent): void => {
    if (!this.overlay.cardOpen) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      this.closeCard(false);
    } else if (e.key === 'Tab' && !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey) {
      // While a card is open, Tab moves into it (Esc returns to the field).
      e.preventDefault();
      this.overlay.focusCard();
    }
  };

  private openCard(s: Suggestion, focus: boolean): void {
    this.overlay.openCard(s, focus);
  }

  private closeCard(returnFocus: boolean): void {
    const wasOpen = this.overlay.cardOpen;
    this.overlay.closeCard();
    if (returnFocus && wasOpen) this.field.focus({ preventScroll: true });
  }

  private openFirst(): void {
    const first = this.visible[0];
    if (!first) return;
    this.field.focus({ preventScroll: true });
    this.field.setSelectionRange(first.start, first.start); // also scrolls the caret into view
    this.overlay.scheduleLayout(false);
    this.openCard(first, true);
  }

  private replace(s: Suggestion, index: number): void {
    this.syncText();
    this.closeCard(false);
    try {
      // applyToField re-verifies version + text; its input event then rebases the other underlines.
      if (!applyToField(this.field, this.snapshot(), s, index)) this.syncText();
    } catch (err) {
      if (!(err instanceof StaleSuggestionError)) throw err;
      this.refresh();
      this.scheduler.runNow(true);
    }
    this.syncText();
    this.scheduler.schedule();
  }

  private addWord(s: Suggestion): void {
    const word = normalizeWord(s.original);
    this.closeCard(true);
    if (!word) return;
    dictionaryLower.add(word.toLowerCase());
    this.refresh();
    const req: AddWordRequest = { target: 'background', type: 'addWord', word };
    chrome.runtime.sendMessage(req).catch(() => {
      if (!extensionAlive()) shutdown();
    });
  }
}

/* ---------- bootstrap ---------- */

if (window.top === window && extensionAlive()) {
  document.addEventListener('focusin', onFocusIn, true);
  // A field may already have focus when we're injected (document_idle, or after an update).
  const focused = asTextField(deepActiveElement());
  if (focused) void activate(focused);
  chrome.runtime.onMessage.addListener((msg: unknown, _sender, sendResponse) => {
    if (!isContentRequest(msg)) return false;
    const info: SiteInfo = { host: location.hostname };
    sendResponse(info);
    return false;
  });
}
