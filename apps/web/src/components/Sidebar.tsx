import { useState } from 'react';
import type { Suggestion } from '@grammarme/core';
import { CATEGORY_LABEL, groupOf, type Group } from '../segments.ts';
import { SuggestionDetail } from './SuggestionDetail.tsx';
import type { CheckStatus } from '../useChecker.ts';

interface Props {
  suggestions: Suggestion[];
  activeId: string | null;
  onActivate(id: string | null): void;
  onAccept(s: Suggestion, index: number): void;
  onDismiss(s: Suggestion): void;
  onAddWord(s: Suggestion): void;
  onDisableRule(s: Suggestion): void;
  onAcceptAllSpelling(): void;
  status: CheckStatus;
}

const FILTERS: { id: 'all' | Group; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'correctness', label: 'Correctness' },
  { id: 'clarity', label: 'Clarity' },
  { id: 'style', label: 'Style' },
];

export function Sidebar(props: Props) {
  const [filter, setFilter] = useState<'all' | Group>('all');
  const counts: Record<Group, number> = { correctness: 0, clarity: 0, style: 0 };
  for (const s of props.suggestions) counts[groupOf(s)]++;
  const shown = props.suggestions.filter((s) => filter === 'all' || groupOf(s) === filter);
  const spellingFixable = props.suggestions.filter(
    (s) => s.category === 'spelling' && s.source === 'harper' && s.replacements.length > 0,
  ).length;

  return (
    <aside className="sidebar" id="suggestions" aria-label="Suggestions">
      <div className="sidebar-head">
        <h2 aria-live="polite">{heading(props.status, props.suggestions.length)}</h2>
        <div className="filters" role="tablist" aria-label="Filter suggestions">
          {FILTERS.map((f) => (
            <button
              key={f.id}
              type="button"
              role="tab"
              aria-selected={filter === f.id}
              className={`filter${filter === f.id ? ' is-on' : ''}`}
              onClick={() => setFilter(f.id)}
            >
              {f.id !== 'all' && <span className={`dot dot-${f.id}`} aria-hidden="true" />}
              {f.label}
              <span className="count">{f.id === 'all' ? props.suggestions.length : counts[f.id]}</span>
            </button>
          ))}
        </div>
        {spellingFixable > 1 && (
          <button type="button" className="btn btn-quiet btn-block" onClick={props.onAcceptAllSpelling}>
            Fix {spellingFixable} spelling mistakes
          </button>
        )}
      </div>

      {shown.length === 0 ? (
        <div className="empty">
          {props.status === 'loading' ? (
            <p className="empty-sub">The checker (about 9 MB) is downloading. This takes a few seconds the first time.</p>
          ) : props.status === 'error' ? (
            <>
              <p className="empty-title">The checker didn’t load.</p>
              <p className="empty-sub">Check your internet connection, then try again. Your text is still here.</p>
              <button type="button" className="btn btn-quiet" onClick={() => window.location.reload()}>
                Try again
              </button>
            </>
          ) : props.status === 'checking' && props.suggestions.length === 0 ? (
            <p className="empty-sub">Checking…</p>
          ) : (
            <>
              <p className="empty-title">{filter === 'all' ? 'No suggestions found.' : 'Nothing in this group.'}</p>
              <p className="empty-sub">Keep writing — suggestions show up as you type.</p>
            </>
          )}
        </div>
      ) : (
        <ol className="cards">
          {shown.map((s) => {
            const open = s.id === props.activeId;
            return (
              <li key={s.id} className={`card${open ? ' is-open' : ''}`}>
                <button
                  type="button"
                  className="card-summary"
                  aria-expanded={open}
                  onClick={() => props.onActivate(open ? null : s.id)}
                >
                  <span className={`dot dot-${groupOf(s)}`} aria-hidden="true" />
                  <span className="card-change">
                    <span className="card-from">{s.original || '∅'}</span>
                    {s.replacements[0] !== undefined && (
                      <>
                        <span className="arrow" aria-hidden="true">
                          →
                        </span>
                        <span className="card-to">{s.replacements[0] === '' ? 'remove' : s.replacements[0]}</span>
                      </>
                    )}
                  </span>
                  <span className="card-cat">{CATEGORY_LABEL[s.category]}</span>
                </button>
                {open && (
                  <div className="card-body">
                    <SuggestionDetail
                      suggestion={s}
                      onAccept={props.onAccept}
                      onDismiss={props.onDismiss}
                      onAddWord={props.onAddWord}
                      onDisableRule={props.onDisableRule}
                    />
                  </div>
                )}
              </li>
            );
          })}
        </ol>
      )}
    </aside>
  );
}

function heading(status: CheckStatus, count: number): string {
  if (count > 0) return `${count} suggestion${count === 1 ? '' : 's'}`;
  if (status === 'loading') return 'Loading checker…';
  if (status === 'error') return 'Couldn’t load the checker';
  if (status === 'checking') return 'Checking…';
  return 'No suggestions found';
}
