/**
 * The on-page UI for ONE field: underlines, a count badge and a suggestion card, all in a closed
 * Shadow DOM so page CSS can't break them and ours can't leak.
 *
 * - <textarea>/<input>: a transparent "mirror" copy of the field's text laid out with the field's
 *   computed font, padding, borders, wrapping and scroll position, placed exactly over it with
 *   `pointer-events: none`. Only underlines (text-decoration on transparent text) are visible.
 * - Rich editors (contenteditable, e.g. Gmail): the browser already lays the text out, so each
 *   underline is a thin bar drawn at the screen rectangles of its DOM Range. Nothing is ever
 *   inserted into the editor itself.
 */
import type { Suggestion } from '@grammarme/core';
import type { Editable, RichEditable } from './editable.ts';
import type { TextField } from './field-dom.ts';
import { OVERLAY_CSS } from './overlay-css.ts';
import {
  CATEGORY_LABEL,
  badgeLabel,
  buildSegments,
  categoryGroup,
  replacementButtons,
  type BadgeState,
} from './segments.ts';

export interface OverlayCallbacks {
  onReplace(s: Suggestion, index: number): void;
  onIgnore(s: Suggestion): void;
  onAddWord(s: Suggestion): void;
  onBadgeClick(): void;
  /** The card should close (Esc, × or click outside). */
  onDismiss(returnFocus: boolean): void;
  /** The field left the DOM. */
  onFieldGone(): void;
}

/** Computed properties that affect text layout, copied from the field onto the mirror. */
const MIRRORED = [
  'direction',
  'writing-mode',
  'font-family',
  'font-size',
  'font-style',
  'font-variant',
  'font-weight',
  'font-stretch',
  'font-kerning',
  'font-feature-settings',
  'font-variation-settings',
  'font-optical-sizing',
  'font-size-adjust',
  'letter-spacing',
  'word-spacing',
  'line-height',
  'text-transform',
  'text-indent',
  'text-align',
  'text-rendering',
  'tab-size',
  'white-space',
  'word-break',
  'overflow-wrap',
  'hyphens',
  'padding-top',
  'padding-left',
  'border-top-width',
  'border-right-width',
  'border-bottom-width',
  'border-left-width',
] as const;

const HOST_STYLE =
  'all: initial !important; position: fixed !important; top: 0 !important; left: 0 !important; ' +
  'width: 0 !important; height: 0 !important; overflow: visible !important; z-index: 2147483646 !important; ' +
  'display: block !important; contain: none !important; transform: none !important; pointer-events: none !important;';

const BADGE_SIZE = 20;
const MAX_CLIP_ANCESTORS = 40;

let sharedSheet: CSSStyleSheet | null = null;
function sheet(): CSSStyleSheet {
  if (!sharedSheet) {
    sharedSheet = new CSSStyleSheet();
    sharedSheet.replaceSync(OVERLAY_CSS);
  }
  return sharedSheet;
}

interface Metrics {
  borderLeft: number;
  borderRight: number;
  borderTop: number;
  borderBottom: number;
  scrollbarX: number;
  scrollbarY: number;
  hasResizeGrip: boolean;
  isInput: boolean;
}

export class Overlay {
  private readonly host: HTMLElement;
  private readonly root: ShadowRoot;
  private readonly mirror: HTMLDivElement;
  /** Rich mode: container for the drawn underline bars. */
  private readonly lines: HTMLDivElement;
  private readonly badge: HTMLButtonElement;
  private readonly field: TextField | HTMLElement;
  private readonly rich: RichEditable | null;
  private richSuggestions: readonly Suggestion[] = [];
  private activeId: string | null = null;
  private card: HTMLDivElement | null = null;
  private cardFor: Suggestion | null = null;
  private spans = new Map<string, HTMLSpanElement>();
  private raf = 0;
  private fullPending = false;
  private clipAncestors: Element[] = [];
  private metrics: Metrics | null = null;
  private destroyed = false;

  constructor(
    target: Editable,
    private readonly cb: OverlayCallbacks,
  ) {
    this.field = target.el;
    this.rich = target.kind === 'rich' ? (target as RichEditable) : null;
    this.host = document.createElement('grammarme-overlay');
    this.host.style.cssText = HOST_STYLE;
    this.root = this.host.attachShadow({ mode: 'closed' });
    this.root.adoptedStyleSheets = [sheet()];

    this.mirror = document.createElement('div');
    this.mirror.className = 'mirror';
    this.mirror.setAttribute('aria-hidden', 'true');
    this.lines = document.createElement('div');
    this.lines.className = 'lines';
    this.lines.setAttribute('aria-hidden', 'true');

    this.badge = document.createElement('button');
    this.badge.type = 'button';
    this.badge.className = 'badge';
    this.badge.style.pointerEvents = 'auto';
    // Keep the field focused (and its caret where it is) when the badge is clicked.
    this.badge.addEventListener('mousedown', (e) => e.preventDefault());
    this.badge.addEventListener('click', () => this.cb.onBadgeClick());

    this.root.append(this.rich ? this.lines : this.mirror, this.badge);
    document.documentElement.append(this.host);
    this.layout(true);
  }

  /** Redraw underlines for `text` (must equal the field's current value). */
  render(text: string, suggestions: readonly Suggestion[], activeId: string | null): void {
    if (this.rich) {
      this.richSuggestions = suggestions;
      this.activeId = activeId;
      this.layout(false);
      return;
    }
    const frag = document.createDocumentFragment();
    const spans = new Map<string, HTMLSpanElement>();
    for (const seg of buildSegments(text, suggestions)) {
      const chunk = text.slice(seg.start, seg.end);
      const s = seg.index >= 0 ? suggestions[seg.index] : undefined;
      if (!s) {
        if (chunk) frag.append(document.createTextNode(chunk));
        continue;
      }
      const span = document.createElement('span');
      span.className = `u ${categoryGroup(s.category)}${s.start === s.end ? ' insert' : ''}${s.id === activeId ? ' active' : ''}`;
      span.textContent = chunk; // textContent only: page text is never parsed as HTML
      spans.set(s.id, span);
      frag.append(span);
    }
    // A trailing newline in a textarea creates a line; a zero-width space makes the mirror match.
    frag.append(document.createTextNode('​'));
    this.mirror.replaceChildren(frag);
    this.spans = spans;
    this.syncScroll();
    if (this.card) this.positionCard();
  }

  setBadge(count: number, state: BadgeState): void {
    const { text, aria } = badgeLabel(count, state);
    this.badge.textContent = text;
    this.badge.setAttribute('aria-label', aria);
    this.badge.title = aria;
    this.badge.className = `badge${count > 0 ? ' issues' : state === 'idle' ? '' : ' muted'}`;
  }

  /** Coalesce position/scroll updates into one animation frame. `full` also re-reads styles. */
  scheduleLayout(full = false): void {
    if (this.destroyed) return;
    this.fullPending ||= full;
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      const f = this.fullPending;
      this.fullPending = false;
      this.layout(f);
    });
  }

  get cardOpen(): boolean {
    return this.card !== null;
  }

  get cardSuggestionId(): string | null {
    return this.cardFor?.id ?? null;
  }

  openCard(s: Suggestion, focusFirst: boolean): void {
    this.closeCard();
    this.layout(false);
    const group = categoryGroup(s.category);
    const card = document.createElement('div');
    card.className = 'card';
    card.style.pointerEvents = 'auto';
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-label', `GrammarMe ${CATEGORY_LABEL[s.category]} suggestion`);

    const head = el('div', 'head');
    const dot = el('span', `dot ${group}`);
    const cat = el('span', 'cat', CATEGORY_LABEL[s.category]);
    const close = button('close', '×', 'Close suggestion');
    close.addEventListener('click', () => this.cb.onDismiss(true));
    head.append(dot, cat, close);
    card.append(head, el('p', 'msg', s.message));

    const repls = replacementButtons(s);
    if (repls.length) {
      const row = el('div', 'repls');
      for (const r of repls) {
        const b = button('repl', r.label, r.ariaLabel);
        b.addEventListener('click', () => this.cb.onReplace(s, r.index));
        row.append(b);
      }
      card.append(row);
    }

    const foot = el('div', 'foot');
    const ignore = button('action', 'Ignore', `Ignore this ${CATEGORY_LABEL[s.category].toLowerCase()} suggestion`);
    ignore.addEventListener('click', () => this.cb.onIgnore(s));
    foot.append(ignore);
    if (s.category === 'spelling') {
      const add = button('action', 'Add to dictionary', `Add “${s.original}” to your dictionary`);
      add.addEventListener('click', () => this.cb.onAddWord(s));
      foot.append(add);
    }
    card.append(foot);

    // Mouse clicks on the card must not move focus/caret out of the field (click still fires).
    card.addEventListener('mousedown', (e) => e.preventDefault());
    card.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        this.cb.onDismiss(true);
      }
    });

    this.root.append(card);
    this.card = card;
    this.cardFor = s;
    this.spans.get(s.id)?.classList.add('active');
    if (this.rich) {
      this.activeId = s.id;
      this.layout(false);
    }
    this.positionCard();
    document.addEventListener('mousedown', this.onDocMouseDown, true);
    if (focusFirst) this.focusCard();
  }

  focusCard(): void {
    this.card?.querySelector<HTMLButtonElement>('button.repl, button.action')?.focus();
  }

  closeCard(): void {
    if (!this.card) return;
    if (this.cardFor) this.spans.get(this.cardFor.id)?.classList.remove('active');
    this.card.remove();
    this.card = null;
    this.cardFor = null;
    if (this.rich) {
      this.activeId = null;
      this.scheduleLayout(false);
    }
    document.removeEventListener('mousedown', this.onDocMouseDown, true);
  }

  destroy(): void {
    this.destroyed = true;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.closeCard();
    this.host.remove();
  }

  private onDocMouseDown = (e: MouseEvent): void => {
    const path = e.composedPath();
    if (path.includes(this.host) || path.includes(this.field)) return;
    this.cb.onDismiss(false);
  };

  private layout(full: boolean): void {
    if (this.destroyed) return;
    const f = this.field;
    if (!f.isConnected) {
      this.cb.onFieldGone();
      return;
    }
    if (this.rich) return this.layoutRich(full);
    if (full || !this.metrics) this.copyStyles();
    const m = this.metrics!;
    const rect = f.getBoundingClientRect();
    const clip = this.visibleRect(rect);
    const shown = rect.width > 0 && rect.height > 0 && clip !== null;
    this.mirror.hidden = !shown;
    this.badge.hidden = !shown;
    if (!shown || !clip) return;

    const ms = this.mirror.style;
    ms.left = `${rect.left}px`;
    ms.top = `${rect.top}px`;
    ms.width = `${rect.width}px`;
    ms.height = `${rect.height}px`;
    ms.clipPath =
      clip.top > rect.top || clip.left > rect.left || clip.right < rect.right || clip.bottom < rect.bottom
        ? `inset(${clip.top - rect.top}px ${rect.right - clip.right}px ${rect.bottom - clip.bottom}px ${clip.left - rect.left}px)`
        : '';
    this.syncScroll();

    // Badge: inside the field's bottom-right, clear of the scrollbar and the resize grip.
    const right = rect.right - m.borderRight - m.scrollbarY - (m.hasResizeGrip && m.scrollbarY === 0 ? 12 : 0) - 4;
    const top = m.isInput
      ? rect.top + (rect.height - BADGE_SIZE) / 2
      : rect.bottom - m.borderBottom - m.scrollbarX - BADGE_SIZE - 4;
    const left = right - Math.max(BADGE_SIZE, this.badge.offsetWidth || BADGE_SIZE);
    this.badge.style.left = `${left}px`;
    this.badge.style.top = `${top}px`;
    this.badge.hidden = top < clip.top || top + BADGE_SIZE > clip.bottom || left < clip.left || right > clip.right;

    if (this.card) this.positionCard();
  }

  /** Rich mode: draw one bar per line box of each suggestion, clipped to the visible editor. */
  private layoutRich(full: boolean): void {
    const rich = this.rich!;
    if (full || !this.clipAncestors.length) this.clipAncestors = clippingAncestors(this.field);
    const rect = this.field.getBoundingClientRect();
    const clip = this.visibleRect(rect);
    const shown = rect.width > 0 && rect.height > 0 && clip !== null;
    this.lines.hidden = !shown;
    this.badge.hidden = !shown;
    if (!shown || !clip) return;

    const frag = document.createDocumentFragment();
    for (const s of this.richSuggestions) {
      const group = categoryGroup(s.category);
      const active = s.id === this.activeId;
      for (const r of rich.rects(s.start, s.end)) {
        const insert = s.start === s.end;
        const left = Math.max(r.left - (insert ? 1 : 0), clip.left);
        const right = Math.min(insert ? r.left + 1 : r.right, clip.right);
        if (right <= left || r.bottom <= clip.top || r.top >= clip.bottom) continue;
        if (active) {
          const hl = document.createElement('div');
          hl.className = `hl ${group}`;
          place(hl, left, Math.max(r.top, clip.top), right - left, Math.min(r.bottom, clip.bottom) - Math.max(r.top, clip.top));
          frag.append(hl);
        }
        const bar = document.createElement('div');
        bar.className = `bar ${group}${insert ? ' insert' : ''}`;
        if (insert) place(bar, left, Math.max(r.top, clip.top), 2, Math.min(r.bottom, clip.bottom) - Math.max(r.top, clip.top));
        else if (r.bottom + 1 <= clip.bottom) place(bar, left, r.bottom - 1, right - left, 2);
        else continue;
        frag.append(bar);
      }
    }
    this.lines.replaceChildren(frag);

    // Badge: bottom-right of the visible part of the editor.
    const right = clip.right - 6;
    const top = clip.bottom - BADGE_SIZE - 6;
    const left = right - Math.max(BADGE_SIZE, this.badge.offsetWidth || BADGE_SIZE);
    this.badge.style.left = `${left}px`;
    this.badge.style.top = `${top}px`;
    this.badge.hidden = top < clip.top || left < clip.left;

    if (this.card) this.positionCard();
  }

  private copyStyles(): void {
    const f = this.field as TextField;
    const cs = getComputedStyle(f);
    const ms = this.mirror.style;
    for (const prop of MIRRORED) ms.setProperty(prop, cs.getPropertyValue(prop));
    const px = (v: string) => parseFloat(v) || 0;
    const borderLeft = px(cs.borderLeftWidth);
    const borderRight = px(cs.borderRightWidth);
    const borderTop = px(cs.borderTopWidth);
    const borderBottom = px(cs.borderBottomWidth);
    const isInput = f instanceof HTMLInputElement;
    // The mirror never shows scrollbars, so pad it by the field's scrollbar size to wrap identically.
    const scrollbarY = Math.max(0, f.offsetWidth - f.clientWidth - borderLeft - borderRight);
    const scrollbarX = Math.max(0, f.offsetHeight - f.clientHeight - borderTop - borderBottom);
    ms.paddingRight = `${px(cs.paddingRight) + scrollbarY}px`;
    ms.paddingBottom = `${px(cs.paddingBottom) + scrollbarX}px`;
    if (isInput) {
      // Single-line inputs never wrap and centre their line vertically in the content box.
      ms.whiteSpace = 'pre';
      ms.overflowWrap = 'normal';
      ms.wordBreak = 'normal';
      const content = f.clientHeight - px(cs.paddingTop) - px(cs.paddingBottom);
      if (content > 0) ms.lineHeight = `${content}px`;
    } else if (f.getAttribute('wrap') === 'off') {
      ms.whiteSpace = 'pre';
    }
    this.metrics = {
      borderLeft,
      borderRight,
      borderTop,
      borderBottom,
      scrollbarX,
      scrollbarY,
      hasResizeGrip: !isInput && cs.resize !== 'none',
      isInput,
    };
    this.clipAncestors = clippingAncestors(f);
  }

  /** The part of the field not clipped by scrolling ancestors or the viewport; null if none. */
  private visibleRect(rect: DOMRect): { left: number; top: number; right: number; bottom: number } | null {
    let left = Math.max(rect.left, 0);
    let top = Math.max(rect.top, 0);
    let right = Math.min(rect.right, window.innerWidth);
    let bottom = Math.min(rect.bottom, window.innerHeight);
    for (const a of this.clipAncestors) {
      const r = a.getBoundingClientRect();
      left = Math.max(left, r.left + a.clientLeft);
      top = Math.max(top, r.top + a.clientTop);
      right = Math.min(right, r.left + a.clientLeft + a.clientWidth);
      bottom = Math.min(bottom, r.top + a.clientTop + a.clientHeight);
    }
    return right > left && bottom > top ? { left, top, right, bottom } : null;
  }

  private syncScroll(): void {
    if (this.rich) return;
    this.mirror.scrollTop = this.field.scrollTop;
    this.mirror.scrollLeft = this.field.scrollLeft;
  }

  private positionCard(): void {
    const card = this.card;
    const s = this.cardFor;
    if (!card || !s) return;
    const span = this.spans.get(s.id);
    const fieldRect = this.field.getBoundingClientRect();
    let anchor: DOMRect | undefined = this.rich
      ? this.rich.rects(s.start, s.end)[0]
      : (span?.getClientRects()[0] ?? span?.getBoundingClientRect());
    if (!anchor || anchor.bottom < fieldRect.top || anchor.top > fieldRect.bottom) anchor = fieldRect;
    const w = card.offsetWidth;
    const h = card.offsetHeight;
    const gap = 6;
    let top = anchor.bottom + gap;
    if (top + h > window.innerHeight - 8 && anchor.top - gap - h >= 8) top = anchor.top - gap - h;
    const left = Math.min(Math.max(8, anchor.left), Math.max(8, window.innerWidth - w - 8));
    card.style.left = `${left}px`;
    card.style.top = `${Math.max(8, top)}px`;
  }
}

function clippingAncestors(field: Element): Element[] {
  const out: Element[] = [];
  let node: Element | null = parentComposed(field);
  while (node && node !== document.documentElement && out.length < MAX_CLIP_ANCESTORS) {
    const cs = getComputedStyle(node);
    if (cs.overflowX !== 'visible' || cs.overflowY !== 'visible') out.push(node);
    if (cs.position === 'fixed') break;
    node = parentComposed(node);
  }
  return out;
}

function place(node: HTMLElement, left: number, top: number, width: number, height: number): void {
  const st = node.style;
  st.left = `${left}px`;
  st.top = `${top}px`;
  st.width = `${Math.max(0, width)}px`;
  st.height = `${Math.max(0, height)}px`;
}

function parentComposed(node: Element): Element | null {
  if (node.parentElement) return node.parentElement;
  const root = node.getRootNode();
  return root instanceof ShadowRoot ? root.host : null;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(className: string, label: string, ariaLabel: string): HTMLButtonElement {
  const b = el('button', className, label);
  b.type = 'button';
  b.setAttribute('aria-label', ariaLabel);
  return b;
}
