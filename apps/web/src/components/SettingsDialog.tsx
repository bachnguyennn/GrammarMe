import { useEffect, useRef, useState } from 'react';
import type { Dialect } from '@grammarme/core';
import type { Settings } from '../storage.ts';

interface Props {
  open: boolean;
  settings: Settings;
  onClose(): void;
  onChange(next: Settings): void;
  onClearDraft(): void;
}

const DIALECTS: { id: Dialect; label: string }[] = [
  { id: 'american', label: 'American English' },
  { id: 'british', label: 'British English' },
  { id: 'canadian', label: 'Canadian English' },
  { id: 'australian', label: 'Australian English' },
  { id: 'indian', label: 'Indian English' },
];

export function SettingsDialog({ open, settings, onClose, onChange, onClearDraft }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const [endpoint, setEndpoint] = useState(settings.aiEndpoint);
  const [token, setToken] = useState(settings.aiToken);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      setEndpoint(settings.aiEndpoint);
      setToken(settings.aiToken);
      d.showModal();
    } else if (!open && d.open) d.close();
  }, [open, settings.aiEndpoint, settings.aiToken]);

  const set = <K extends keyof Settings>(key: K, value: Settings[K]) => onChange({ ...settings, [key]: value });
  const endpointValid = /^https?:\/\/[^\s]+$/.test(endpoint.trim());

  return (
    <dialog ref={ref} className="dialog" onClose={onClose} aria-labelledby="settings-title">
      <form method="dialog" className="dialog-inner" onSubmit={() => onChange({ ...settings, aiEndpoint: endpoint.trim(), aiToken: token.trim() })}>
        <header className="dialog-head">
          <h2 id="settings-title">Settings</h2>
          <button type="button" className="icon-btn" aria-label="Close settings" onClick={onClose}>
            ×
          </button>
        </header>

        <section className="field-group">
          <h3>Language</h3>
          <label className="field">
            <span>Dialect</span>
            <select value={settings.dialect} onChange={(e) => set('dialect', e.target.value as Dialect)}>
              {DIALECTS.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.label}
                </option>
              ))}
            </select>
          </label>
        </section>

        <section className="field-group">
          <h3>Personal dictionary</h3>
          {settings.dictionary.length === 0 ? (
            <p className="hint">Words you add from a spelling suggestion appear here.</p>
          ) : (
            <ul className="tags">
              {settings.dictionary.map((w) => (
                <li key={w}>
                  {w}
                  <button
                    type="button"
                    aria-label={`Remove ${w}`}
                    onClick={() => set('dictionary', settings.dictionary.filter((x) => x !== w))}
                  >
                    ×
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        {settings.disabledRules.length > 0 && (
          <section className="field-group">
            <h3>Turned-off rules</h3>
            <ul className="tags">
              {settings.disabledRules.map((r) => (
                <li key={r}>
                  {r}
                  <button
                    type="button"
                    aria-label={`Turn ${r} back on`}
                    onClick={() => set('disabledRules', settings.disabledRules.filter((x) => x !== r))}
                  >
                    ×
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}

        <section className="field-group">
          <h3>Privacy</h3>
          <label className="check">
            <input type="checkbox" checked={settings.saveDraft} onChange={(e) => set('saveDraft', e.target.checked)} />
            <span>Keep my draft in this browser</span>
          </label>
          <button type="button" className="btn btn-quiet" onClick={onClearDraft}>
            Delete saved draft
          </button>
        </section>

        <section className="field-group ai-group">
          <h3>Cloud AI suggestions</h3>
          <p className="hint">
            Off by default. Grammar and spelling checks always run on this device. When you turn this on and press{' '}
            <b>AI check</b>, the text is sent to <b>your</b> GrammarMe AI server, which forwards it to the model provider
            you configured. Nothing is sent while you type.
          </p>
          <label className="check">
            <input
              type="checkbox"
              checked={settings.aiEnabled}
              onChange={(e) => set('aiEnabled', e.target.checked)}
            />
            <span>Enable AI check button</span>
          </label>
          <label className="field">
            <span>Server URL</span>
            <input
              type="url"
              inputMode="url"
              placeholder="https://grammarme-ai.<you>.workers.dev"
              value={endpoint}
              onChange={(e) => setEndpoint(e.target.value)}
              aria-invalid={endpoint !== '' && !endpointValid}
            />
          </label>
          <label className="field">
            <span>Access token</span>
            <input
              type="password"
              autoComplete="off"
              value={token}
              onChange={(e) => setToken(e.target.value)}
            />
          </label>
          <p className="hint">Stored only in this browser. See workers/ai-api/README.md to set up the free server.</p>
        </section>

        <footer className="dialog-foot">
          <button type="submit" className="btn btn-primary" disabled={endpoint !== '' && !endpointValid}>
            Done
          </button>
        </footer>
      </form>
    </dialog>
  );
}
