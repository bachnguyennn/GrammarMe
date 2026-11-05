import { useState } from 'react';
import type { Suggestion } from '@grammarme/core';
import { CATEGORY_LABEL, groupOf, type Group } from '../segments.ts';
import { SuggestionDetail } from './SuggestionDetail.tsx';

interface Props {
  suggestions: Suggestion[];
  activeId: string | null;
  onActivate(id: string | null): void;
  onAccept(s: Suggestion, index: number): void;
  onDismiss(s: Suggestion): void;
  onAddWord(s: Suggestion): void;
  onDisableRule(s: Suggestion): void;
  onAcceptAllSpelling(): void;
  ready: boolean;
}

const FILTERS: { id: 'all' | Group; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'correctness', label: 'Correctness' },
  { id: 'clarity', label: 'Clarity' },
  { id: 'style', label: 'Style' },
  { id: 'ai', label: 'AI' },
];

export function Sidebar(props: Props) {
  const [filter, setFilter] = useState<'all' | Group>('all');
  const counts: Record<Group, number> = { correctness: 0, clarity: 0, style: 0, ai: 0 };
  for (const s of props.suggestions) counts[groupOf(s)]++;
  const shown = props.suggestions.filter((s) => filter === 'all' || groupOf(s) === filter);
  const spellingFixable = props.suggestions.filter(
    (s) => s.category === 'spelling' && s.source === 'harper' && s.replacements.length > 0,
  ).length;

  return (
    <aside className="sidebar" aria-label="Suggestions">
      <div className="sidebar-head">
        <h2>
          {props.suggestions.length === 0 ? 'No issues' : `${props.suggestions.length} suggestion${props.suggestions.length === 1 ? '' : 's'}`}
        </h2>
        <div className="filters" role="tablist" aria-label="Filter suggestions">
          {FILTERS.filter((f) => f.id !== 'ai' || counts.ai > 0).map((f) => (
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
          {props.ready ? (
            <>
              <p className="empty-title">{filter === 'all' ? 'Looking good.' : 'Nothing here.'}</p>
              <p className="empty-sub">Keep writing — suggestions show up as you type.</p>
            </>
          ) : (
            <p className="empty-sub">Loading the grammar engine…</p>
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
