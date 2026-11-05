/**
 * Content script — injected into every page, but does nothing until an eligible text field is
 * focused. Top-level cost: one `focusin` listener and one runtime message listener.
 *
 * Scope: <textarea>, <input type=text|search>, and rich-text editors (contenteditable, e.g. Gmail's
 * compose body). Google Docs draws text on a canvas and is out of scope (see docs/extension.md).
 */
import {
  StaleSuggestionError,
  isApplicable,
  rebaseSuggestions,
  type DocumentSnapshot,
  type Suggestion,
} from '@grammarme/core';
import type { AiTask } from '@grammarme/core';
import { MANAGE_USAGE_URL } from '@grammarme/core/companion';
import { AI_READY_KEY, newRequestId, type AiCancelRequest, type AiCheckRequest, type AiCheckResponse, type AiErrorCode } from './ai-protocol.ts';
import { SCOPE_LABEL, aiScope, placeAiEdits, type AiScope } from './ai-scope.ts';
import { asEditable, type Editable } from './editable.ts';
import { fieldEligibility } from './eligibility.ts';
import { deepActiveElement } from './field-dom.ts';
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
  /** Optional ChatGPT suggestions, kept apart from Harper's (which each check replaces). */
  ai: Suggestion[];
}

const memory = new WeakMap<HTMLElement, FieldMemory>();
let settings: Settings | null = null;
let dictionaryLower = new Set<string>();
let loading: Promise<void> | null = null;
let active: FieldController | null = null;
let shutDown = false;
/** ChatGPT connected with plan usage (a non-secret flag the service worker maintains). */
let aiReady = false;

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
      chrome.storage.local.get([DICTIONARY_KEY, AI_READY_KEY]),
    ]);
    settings = normalizeSettings(sync[SETTINGS_KEY]);
    dictionaryLower = new Set(normalizeDictionary(local[DICTIONARY_KEY]).map((w) => w.toLowerCase()));
    aiReady = Boolean((local[AI_READY_KEY] as { ready?: boolean } | undefined)?.ready);
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
  if (area === 'local' && changes[AI_READY_KEY]) {
    aiReady = Boolean((changes[AI_READY_KEY].newValue as { ready?: boolean } | undefined)?.ready);
    active?.setAiAvailable(aiReady);
  }
  if (area === 'local' && changes[DICTIONARY_KEY]) {
    dictionaryLower = new Set(normalizeDictionary(changes[DICTIONARY_KEY].newValue).map((w) => w.toLowerCase()));
    active?.refresh();
  }
}

function onFocusIn(e: FocusEvent): void {
  if (!extensionAlive()) return shutdown();
  const target = asEditable(e.composedPath()[0]);
  if (!target) return;
  if (active?.field === target.el) return active.onRefocus();
  void activate(target);
}

async function activate(target: Editable): Promise<void> {
  const field = target.el;
  try {
    await ensureLoaded();
  } catch {
    return shutdown(); // storage unavailable => extension context gone
  }
  if (!settings || !isActiveOn(settings, location.hostname)) return;
  if (!field.isConnected || deepActiveElement() !== field || active?.field === field) return;
  if (!fieldEligibility(target.describe()).eligible) return;
  active?.destroy();
  let mem = memory.get(field);
  if (!mem) {
    mem = { text: target.readText(), version: 0, suggestions: [], ignored: new Set(), ai: [] };
    memory.set(field, mem);
  }
  active = new FieldController(target, mem);
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
  /** Rich editors: catches text changes made by the page itself (no input event). */
  private readonly mutationObserver: MutationObserver | null = null;
  private mutationRaf = 0;
  readonly field: HTMLElement;
  private visible: Suggestion[] = [];
  private state: BadgeState = 'idle';
  private destroyed = false;

  constructor(
    private readonly target: Editable,
    private readonly mem: FieldMemory,
  ) {
    const field = target.el;
    this.field = field;
    this.overlay = new Overlay(target, {
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
      onAiClick: () => this.openAi(),
    });
    this.overlay.setAiAvailable(aiReady);
    this.scheduler = new CheckScheduler({
      delayMs: CHECK_DEBOUNCE_MS,
      current: () => ({ text: this.mem.text, version: this.mem.version }),
      // Empty text never wakes the engine (no offscreen document, no memory spent).
      shouldCheck: (snap) => snap.text.trim().length > 0 && snap.text.length <= MAX_CHECK_CHARS,
      check: async (snap) => {
        // Re-verify right before text leaves this script: pages flip fields to readonly, or a
        // "show password" toggle turns type=password into type=text while we're attached.
        if (!fieldEligibility(this.target.describe()).eligible) {
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
    if (target.kind === 'rich') {
      this.mutationObserver = new MutationObserver(this.onMutation);
      this.mutationObserver.observe(field, { subtree: true, childList: true, characterData: true });
    }

    this.syncText();
    this.refresh();
    this.scheduler.runNow();
  }

  /** Recompute what's shown from memory + ignore list + dictionary. */
  refresh(): void {
    if (this.destroyed) return;
    this.visible = visibleSuggestions([...this.mem.suggestions, ...this.mem.ai], this.mem.ignored, dictionaryLower);
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
    this.cancelAi();
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
    this.mutationObserver?.disconnect();
    if (this.mutationRaf) cancelAnimationFrame(this.mutationRaf);
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
    const text = this.target.readText();
    if (text === this.mem.text) return false;
    const prev = this.mem.text;
    this.mem.version += 1;
    this.mem.text = text;
    this.mem.suggestions = rebaseSuggestions(prev, { text, version: this.mem.version }, this.mem.suggestions);
    this.mem.ai = rebaseSuggestions(prev, { text, version: this.mem.version }, this.mem.ai);
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

  /** Page-made edits in a rich editor: resync once per frame; layout-only changes just redraw. */
  private onMutation = (): void => {
    if (this.mutationRaf) return;
    this.mutationRaf = requestAnimationFrame(() => {
      this.mutationRaf = 0;
      if (this.destroyed) return;
      if (this.syncText()) this.scheduler.schedule();
      else this.overlay.scheduleLayout(false);
    });
  };

  private onScroll = (): void => this.overlay.scheduleLayout(false);
  private onResize = (): void => this.overlay.scheduleLayout(true);

  private onMouseUp = (): void => {
    if (this.syncText()) this.scheduler.schedule();
    const sel = this.target.selection();
    if (!sel || sel.start !== sel.end) return; // a real selection, not a click on a word
    const hit = suggestionAt(this.visible, sel.start, true);
    if (hit) this.openCard(hit, false);
    else this.closeCard(false);
  };

  private onKeyUp = (e: KeyboardEvent): void => {
    if (!NAV_KEYS.has(e.key)) return;
    const sel = this.target.selection();
    if (!sel || sel.start !== sel.end) return;
    const hit = suggestionAt(this.visible, sel.start, false);
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
    this.target.setCaret(first.start);
    this.overlay.scheduleLayout(false);
    this.openCard(first, true);
  }

  private replace(s: Suggestion, index: number): void {
    this.syncText();
    this.closeCard(false);
    try {
      // apply() re-verifies version + text; its input event then rebases the other underlines.
      if (!this.target.apply(this.snapshot(), s, index)) this.syncText();
    } catch (err) {
      if (!(err instanceof StaleSuggestionError)) throw err;
      this.refresh();
      this.scheduler.runNow(true);
    }
    this.syncText();
    this.scheduler.schedule();
  }

  /* ---------------- optional ChatGPT check (user-triggered only) ---------------- */

  private aiTask: AiTask = 'grammar';
  private aiScope: AiScope | null = null;
  private aiRequestId: string | null = null;

  setAiAvailable(ready: boolean): void {
    if (this.destroyed) return;
    this.overlay.setAiAvailable(ready);
    if (!ready && !this.aiRequestId) this.overlay.closePanel();
  }

  /** Step 1: show exactly what would be sent, where, and let the user choose the check. */
  private openAi(): void {
    if (this.destroyed || this.aiRequestId) return;
    this.syncText();
    const sel = this.target.selection();
    const picked = aiScope(this.mem.text, sel?.start ?? null, sel?.end ?? null);
    if (!picked.ok) {
      this.aiScope = null;
      this.overlay.showPanel({
        title: 'Check with ChatGPT',
        lines: [
          picked.reason === 'empty'
            ? 'There’s no text to check yet.'
            : 'That’s too much text for one check (4,000 characters at most). Select a shorter part and try again.',
        ],
        actions: [{ label: 'Close', onClick: () => this.closeAi() }],
        onClose: () => this.closeAi(),
      });
      return;
    }
    this.aiScope = picked.scope;
    this.renderCompose();
    this.overlay.focusPanel();
  }

  private renderCompose(): void {
    const scope = this.aiScope;
    if (!scope) return;
    this.overlay.showPanel({
      title: 'Check with ChatGPT',
      tasks: {
        options: [
          { id: 'grammar', label: 'Grammar' },
          { id: 'clarity', label: 'Clarity' },
          { id: 'tone', label: 'Tone' },
        ],
        current: this.aiTask,
        onPick: (id) => {
          this.aiTask = id as AiTask;
          this.renderCompose();
        },
      },
      lines: [`Checking ${SCOPE_LABEL[scope.kind]} (${scope.text.length.toLocaleString('en-US')} characters):`],
      preview: scope.text,
      notice:
        'Pressing Send shares this text with OpenAI, using your ChatGPT plan’s allowance. Nothing is sent while you type, and only this text is sent.',
      actions: [
        { label: 'Send to ChatGPT', primary: true, onClick: () => void this.sendAi() },
        { label: 'Cancel', onClick: () => this.closeAi() },
      ],
      onClose: () => this.closeAi(),
    });
  }

  /** Step 2: send the previewed text once; refuse if the text changed under the preview. */
  private async sendAi(): Promise<void> {
    const scope = this.aiScope;
    if (!scope || this.aiRequestId || this.destroyed) return;
    this.syncText();
    if (this.mem.text.slice(scope.start, scope.end) !== scope.text) {
      // The user typed since the preview: show the new text instead of sending something unseen.
      this.aiScope = null;
      this.openAi();
      return;
    }
    const sent: DocumentSnapshot = this.snapshot();
    const requestId = newRequestId();
    this.aiRequestId = requestId;
    const task = this.aiTask;
    this.overlay.showPanel({
      title: 'Check with ChatGPT',
      lines: ['Checking with ChatGPT…'],
      actions: [{ label: 'Cancel', onClick: () => this.cancelAi() }],
      onClose: () => this.cancelAi(),
    });
    const req: AiCheckRequest = { target: 'background', type: 'aiCheck', requestId, task, mode: 'standard', text: scope.text };
    let res: AiCheckResponse;
    try {
      res = (await chrome.runtime.sendMessage(req)) as AiCheckResponse;
      if (!res || typeof res !== 'object') throw new Error('no response');
    } catch {
      res = { ok: false, error: 'interrupted', message: 'The connection to GrammarMe’s companion was interrupted. Try again.' };
    }
    if (this.aiRequestId !== requestId || this.destroyed) return; // cancelled meanwhile
    this.aiRequestId = null;
    if (!res.ok) return this.showAiError(res.error, res.message);

    this.syncText();
    const placed = placeAiEdits(res.edits, scope, sent, this.snapshot());
    // Replace earlier ChatGPT suggestions inside this range; keep ones elsewhere.
    this.mem.ai = [
      ...this.mem.ai.filter((s) => s.end <= scope.start || s.start >= scope.end),
      ...placed.suggestions,
    ];
    this.refresh();
    const skipped = placed.dropped + res.dropped;
    const n = placed.suggestions.length;
    this.overlay.showPanel({
      title: 'Check with ChatGPT',
      lines: [
        n === 0 ? 'ChatGPT suggested no changes.' : `ChatGPT suggested ${n} edit${n === 1 ? '' : 's'}. They’re underlined; click one to accept or dismiss it.`,
        ...(skipped > 0
          ? [`${skipped} more ${skipped === 1 ? 'wasn’t' : 'weren’t'} shown because ${skipped === 1 ? 'it' : 'they'} couldn’t be placed safely or might change your meaning.`]
          : []),
      ],
      actions: [{ label: 'Done', primary: true, onClick: () => this.closeAi() }],
      onClose: () => this.closeAi(),
    });
    this.overlay.focusPanel();
  }

  private showAiError(code: AiErrorCode, message: string): void {
    if (this.destroyed) return;
    const reconnect = code === 'not_connected' || code === 'reauth_required' || code === 'permission_required';
    this.overlay.showPanel({
      title: 'Check with ChatGPT',
      error: message,
      lines: reconnect
        ? ['Open the GrammarMe button in Chrome’s toolbar to connect again.']
        : /local/i.test(message) || code === 'cancelled'
          ? []
          : ['Local spelling and grammar checks keep working.'],
      link: code === 'usage_limit' || code === 'usage_unavailable' ? { text: 'Manage usage ↗', href: MANAGE_USAGE_URL } : undefined,
      actions: [
        ...(code === 'cancelled' || reconnect ? [] : [{ label: 'Try again', onClick: () => this.renderCompose() }]),
        { label: 'Close', primary: code === 'cancelled', onClick: () => this.closeAi() },
      ],
      onClose: () => this.closeAi(),
    });
  }

  private cancelAi(): void {
    const id = this.aiRequestId;
    if (!id) return;
    this.aiRequestId = null;
    const msg: AiCancelRequest = { target: 'background', type: 'aiCancel', requestId: id };
    chrome.runtime.sendMessage(msg).catch(() => undefined);
    if (!this.destroyed) this.showAiError('cancelled', 'AI check cancelled. Nothing more will be sent.');
  }

  private closeAi(): void {
    if (this.aiRequestId) this.cancelAi();
    this.aiScope = null;
    this.overlay.closePanel();
    if (!this.destroyed) this.field.focus({ preventScroll: true });
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
  const focused = asEditable(deepActiveElement());
  if (focused) void activate(focused);
  chrome.runtime.onMessage.addListener((msg: unknown, _sender, sendResponse) => {
    if (!isContentRequest(msg)) return false;
    const info: SiteInfo = { host: location.hostname };
    sendResponse(info);
    return false;
  });
}
