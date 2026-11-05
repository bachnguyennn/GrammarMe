import type { Suggestion } from '@grammarme/core';
import { CATEGORY_LABEL, groupOf } from '../segments.ts';

interface Props {
  suggestion: Suggestion;
  onAccept(s: Suggestion, index: number): void;
  onDismiss(s: Suggestion): void;
  onAddWord(s: Suggestion): void;
  onDisableRule(s: Suggestion): void;
}

/** The body shared by the inline popover and the expanded sidebar card. */
export function SuggestionDetail({ suggestion: s, onAccept, onDismiss, onAddWord, onDisableRule }: Props) {
  const group = groupOf(s);
  return (
    <div className="detail">
      <div className="detail-head">
        <span className={`dot dot-${group}`} aria-hidden="true" />
        <span className="detail-cat">{CATEGORY_LABEL[s.category]}</span>
        {s.source === 'ai' && (
          <span className="chip" title="Suggested by the cloud AI model you enabled">
            AI
          </span>
        )}
      </div>
      <p className="detail-msg">{renderMessage(s.message)}</p>
      {s.replacements.length > 0 ? (
        <div className="fixes">
          {s.replacements.slice(0, 3).map((r, i) => (
            <button key={i} type="button" className={i === 0 ? 'fix fix-primary' : 'fix'} onClick={() => onAccept(s, i)}>
              {r === '' ? (
                <>
                  <s>{s.original}</s> <span className="fix-note">remove</span>
                </>
              ) : (
                r
              )}
            </button>
          ))}
        </div>
      ) : (
        <p className="detail-note">No automatic fix. Rewrite this part yourself.</p>
      )}
      <div className="detail-actions">
        <button type="button" className="link" onClick={() => onDismiss(s)}>
          Dismiss
        </button>
        {s.category === 'spelling' && s.source === 'harper' && (
          <button type="button" className="link" onClick={() => onAddWord(s)}>
            Add “{s.original}” to dictionary
          </button>
        )}
        {s.source === 'harper' && (
          <button type="button" className="link link-muted" onClick={() => onDisableRule(s)} title={`Rule: ${s.rule}`}>
            Turn off this rule
          </button>
        )}
      </div>
    </div>
  );
}

/** Harper messages use `backticks` for quoted words; show those as inline code, never as HTML. */
function renderMessage(message: string) {
  return message.split('`').map((part, i) => (i % 2 ? <code key={i}>{part}</code> : part));
}
