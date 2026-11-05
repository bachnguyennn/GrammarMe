import { forwardRef, memo, useImperativeHandle, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import type { Suggestion } from '@grammarme/core';
import { buildSegments, groupOf } from '../segments.ts';
import { SuggestionDetail } from './SuggestionDetail.tsx';

export interface EditorHandle {
  textarea: HTMLTextAreaElement | null;
  focusRange(start: number, end: number): void;
}

interface Props {
  text: string;
  suggestions: Suggestion[];
  activeId: string | null;
  onInput(text: string): void;
  onActivate(id: string | null): void;
  onAccept(s: Suggestion, index: number): void;
  onDismiss(s: Suggestion): void;
  onAddWord(s: Suggestion): void;
  onDisableRule(s: Suggestion): void;
  placeholder?: string;
}

/**
 * A native <textarea> owns the text, caret and undo stack (so nothing can jump or desync);
 * a backdrop with identical metrics sits behind it and draws the underlines.
 */
export const Editor = forwardRef<EditorHandle, Props>(function Editor(props, ref) {
  const { text, suggestions, activeId, onInput, onActivate } = props;
  const taRef = useRef<HTMLTextAreaElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const backdropRef = useRef<HTMLDivElement>(null);
  const [popover, setPopover] = useState<{ top: number; left: number } | null>(null);
  const active = suggestions.find((s) => s.id === activeId) ?? null;

  useImperativeHandle(ref, () => ({
    get textarea() {
      return taRef.current;
    },
    focusRange(start, end) {
      const ta = taRef.current;
      if (!ta) return;
      ta.focus({ preventScroll: true });
      ta.setSelectionRange(start, end);
    },
  }));

  // Grow with content so the page scrolls, not the textarea — keeps backdrop alignment trivial.
  useLayoutEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = `${ta.scrollHeight}px`;
  }, [text]);

  // Place the card under the active underline.
  useLayoutEffect(() => {
    if (!active || !wrapRef.current || !backdropRef.current) {
      setPopover(null);
      return;
    }
    const mark = backdropRef.current.querySelector<HTMLElement>(`[data-id="${CSS.escape(active.id)}"]`);
    if (!mark) {
      setPopover(null);
      return;
    }
    const wrap = wrapRef.current.getBoundingClientRect();
    const rects = mark.getClientRects();
    const r = rects[rects.length - 1] ?? mark.getBoundingClientRect();
    const width = Math.min(340, wrap.width);
    setPopover({ top: r.bottom - wrap.top + 8, left: Math.max(0, Math.min(r.left - wrap.left, wrap.width - width)) });
  }, [active, text]);

  const syncActiveFromCaret = () => {
    const ta = taRef.current;
    if (!ta || ta.selectionStart !== ta.selectionEnd) return;
    const caret = ta.selectionStart;
    const hit = suggestions.find((s) => s.start <= caret && caret <= s.end && s.end > s.start);
    onActivate(hit?.id ?? null);
  };

  return (
    <div className="editor" ref={wrapRef}>
      <Backdrop ref={backdropRef} text={text} suggestions={suggestions} activeId={activeId} />
      <textarea
        ref={taRef}
        className="editor-input"
        defaultValue={text}
        spellCheck={false}
        autoCorrect="off"
        autoCapitalize="sentences"
        aria-label="Document text"
        aria-describedby="editor-help"
        placeholder={props.placeholder}
        onInput={(e) => onInput(e.currentTarget.value)}
        onClick={syncActiveFromCaret}
        onKeyUp={(e) => {
          if (e.key.startsWith('Arrow') || e.key === 'Home' || e.key === 'End') syncActiveFromCaret();
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && activeId) {
            e.preventDefault();
            onActivate(null);
          }
          // Alt+Enter accepts the top suggestion under the caret.
          if (e.key === 'Enter' && e.altKey && active && active.replacements.length) {
            e.preventDefault();
            props.onAccept(active, 0);
          }
        }}
      />
      <p id="editor-help" className="sr-only">
        Issues are underlined. Move the caret into an underlined word to see the suggestion. Alt+Enter accepts it,
        Escape closes it.
      </p>
      {active && popover && (
        <div
          className="popover"
          role="dialog"
          aria-label="Suggestion"
          style={{ top: popover.top, left: popover.left } as CSSProperties}
          onMouseDown={(e) => e.preventDefault() /* keep focus + caret in the textarea */}
        >
          <SuggestionDetail
            suggestion={active}
            onAccept={props.onAccept}
            onDismiss={props.onDismiss}
            onAddWord={props.onAddWord}
            onDisableRule={props.onDisableRule}
          />
        </div>
      )}
    </div>
  );
});

const Backdrop = memo(
  forwardRef<HTMLDivElement, { text: string; suggestions: Suggestion[]; activeId: string | null }>(function Backdrop(
    { text, suggestions, activeId },
    ref,
  ) {
    const segments = buildSegments(text, suggestions);
    return (
      <div className="editor-backdrop" ref={ref} aria-hidden="true">
        {segments.map((seg, i) =>
          seg.suggestion ? (
            <mark
              key={seg.suggestion.id}
              data-id={seg.suggestion.id}
              className={`u u-${groupOf(seg.suggestion)}${seg.suggestion.id === activeId ? ' is-active' : ''}`}
            >
              {seg.text}
            </mark>
          ) : (
            <span key={`t${i}`}>{seg.text}</span>
          ),
        )}
        {/* A trailing newline in a textarea still takes a line; mirror that. */}
        {'​'}
      </div>
    );
  }),
);
