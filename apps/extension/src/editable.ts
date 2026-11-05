/**
 * One interface over the two kinds of editable things GrammarMe checks:
 * - `FieldEditable`: <textarea> / <input> (value + selectionStart/End).
 * - `RichEditable`: a contenteditable editing host such as Gmail's compose body (DOM text via
 *   rich-text.ts, Ranges for underlines and edits).
 * The controller in content.ts and the overlay only talk to this interface.
 */
import { applySuggestion, type DocumentSnapshot, type Suggestion } from '@grammarme/core';
import { applyToField } from './apply.ts';
import type { FieldInfo } from './eligibility.ts';
import { asTextField, closestComposed, describeField, type TextField } from './field-dom.ts';
import { domPointAt, extractText, offsetAtDom, type TextMap } from './rich-text.ts';

export interface Editable {
  readonly el: HTMLElement;
  readonly kind: 'field' | 'rich';
  /** Current text as the checker sees it. */
  readText(): string;
  /** Caret/selection as string offsets, or null when it's not inside this editable. */
  selection(): { start: number; end: number } | null;
  /** Put the caret at `offset` and scroll it into view. */
  setCaret(offset: number): void;
  /**
   * Replace `s` with replacement `index`, through the browser's editing commands so the page's
   * own undo and framework state stay correct. Throws StaleSuggestionError when `doc` is out of
   * date; returns true when the text now matches the expected result.
   */
  apply(doc: DocumentSnapshot, s: Suggestion, index: number): boolean;
  describe(): FieldInfo;
}

export class FieldEditable implements Editable {
  readonly kind = 'field';
  constructor(readonly el: TextField) {}
  readText(): string {
    return this.el.value;
  }
  selection(): { start: number; end: number } | null {
    const { selectionStart: a, selectionEnd: b } = this.el;
    return a === null || b === null ? null : { start: a, end: b };
  }
  setCaret(offset: number): void {
    this.el.focus({ preventScroll: true });
    this.el.setSelectionRange(offset, offset); // also scrolls the caret into view
  }
  apply(doc: DocumentSnapshot, s: Suggestion, index: number): boolean {
    return applyToField(this.el, doc, s, index);
  }
  describe(): FieldInfo {
    return describeField(this.el);
  }
}

const CODE_EDITOR_SELECTOR = '.cm-content, .CodeMirror, .ace_editor, .monaco-editor, pre, code, [data-language]';

export class RichEditable implements Editable {
  readonly kind = 'rich';
  private map: TextMap | null = null;

  constructor(readonly el: HTMLElement) {}

  readText(): string {
    this.map = extractText(this.el);
    return this.map.text;
  }

  /** The text map from the last `readText()` (rebuilt if none yet). */
  textMap(): TextMap {
    return (this.map ??= extractText(this.el));
  }

  /** A live Range covering [start, end) of the last read text, or null if it can't be mapped. */
  range(start: number, end: number): Range | null {
    const map = this.textMap();
    const a = domPointAt(map, start, 'forward');
    const b = start === end ? a : domPointAt(map, end, 'backward');
    if (!a || !b || !a.node.isConnected || !b.node.isConnected) return null;
    const r = document.createRange();
    try {
      r.setStart(a.node, a.offset);
      r.setEnd(b.node, b.offset);
    } catch {
      return null;
    }
    return r;
  }

  /** Screen rectangles for [start, end); a collapsed range gives one zero-width rect. */
  rects(start: number, end: number): DOMRect[] {
    const r = this.range(start, end);
    if (!r) return [];
    const list = Array.from(r.getClientRects()).filter((x) => x.height > 0);
    if (list.length || start !== end) return list;
    const b = r.getBoundingClientRect();
    return b.height > 0 ? [b] : [];
  }

  selection(): { start: number; end: number } | null {
    const sel = this.el.ownerDocument.getSelection();
    if (!sel || sel.rangeCount === 0) return null;
    const r = sel.getRangeAt(0);
    if (!this.el.contains(r.startContainer) || !this.el.contains(r.endContainer)) return null;
    const map = this.textMap();
    const start = offsetAtDom(map, r.startContainer, r.startOffset);
    const end = offsetAtDom(map, r.endContainer, r.endOffset);
    return start === null || end === null ? null : { start, end };
  }

  setCaret(offset: number): void {
    const r = this.range(offset, offset);
    this.el.focus({ preventScroll: true });
    if (!r) return;
    const sel = this.el.ownerDocument.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(r);
    const anchor = r.startContainer.nodeType === Node.ELEMENT_NODE ? (r.startContainer as Element) : r.startContainer.parentElement;
    anchor?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  apply(doc: DocumentSnapshot, s: Suggestion, index: number): boolean {
    const expected = applySuggestion(doc, s, index); // version + text check; throws if stale
    if (this.readText() !== doc.text) return false;
    const r = this.range(s.start, s.end);
    if (!r) return false;
    const replacement = s.replacements[index] ?? '';
    this.el.focus({ preventScroll: true });
    const sel = this.el.ownerDocument.getSelection();
    if (!sel) return false;
    sel.removeAllRanges();
    sel.addRange(r);
    try {
      // The editor (Gmail, ProseMirror, Lexical…) handles this like typing: its undo and its own
      // model stay in sync. We never write into the page's DOM directly, which could corrupt it.
      if (replacement === '') {
        if (s.start !== s.end) document.execCommand('delete', false);
      } else {
        document.execCommand('insertText', false, replacement);
      }
    } catch {
      /* refused: the text check below reports it */
    }
    return this.readText() === expected.text;
  }

  describe(): FieldInfo {
    const el = this.el;
    const rect = el.getBoundingClientRect();
    const base = describeField(el);
    return {
      ...base,
      tagName: el.tagName,
      type: null,
      autocomplete: null,
      name: el.getAttribute('aria-label'),
      readOnly: el.getAttribute('aria-readonly') === 'true',
      disabled: el.getAttribute('aria-disabled') === 'true',
      width: rect.width,
      height: rect.height,
      contentEditable: el.isContentEditable,
      codeEditor: closestComposed(el, CODE_EDITOR_SELECTOR) !== null || el.querySelector('.cm-line, .ace_line, .view-line') !== null,
    };
  }
}

/** The outermost contenteditable ancestor of `el` (the editing host), or null. */
export function editingHost(el: Element): HTMLElement | null {
  if (!(el instanceof HTMLElement) || !el.isContentEditable) return null;
  let host: HTMLElement = el;
  while (host.parentElement?.isContentEditable) host = host.parentElement;
  return host;
}

/** Wrap a focus target in the right Editable, or null if it isn't something we edit. */
export function asEditable(target: EventTarget | null | undefined): Editable | null {
  const field = asTextField(target);
  if (field) return new FieldEditable(field);
  if (target instanceof Element) {
    const host = editingHost(target);
    if (host) return new RichEditable(host);
  }
  return null;
}
