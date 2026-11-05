import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { isApplicable, readabilityLabel, textStats, type AiTask, type Suggestion, type WritingMode } from '@grammarme/core';
import { Editor, type EditorHandle } from './components/Editor.tsx';
import { Sidebar } from './components/Sidebar.tsx';
import { SettingsDialog } from './components/SettingsDialog.tsx';
import { useChecker } from './useChecker.ts';
import { runAiCheck } from './ai.ts';
import { loadDraft, loadSettings, saveDraft, saveSettings, type Settings } from './storage.ts';
import { SAMPLE } from './sample.ts';


/** The product home page: the editor is served from /editor/, so home is one level up. */
const HOME_URL = '../';

const MODES: { id: WritingMode; label: string; hint: string }[] = [
  { id: 'standard', label: 'Standard', hint: 'All checks' },
  { id: 'academic', label: 'Academic', hint: 'Formal; AI keeps citations and terms intact' },
  { id: 'professional', label: 'Professional', hint: 'Clear and concise' },
  { id: 'casual', label: 'Casual', hint: 'Correctness only — hides style nitpicks' },
];

interface Toast {
  message: string;
  undo?: boolean;
}

export function App() {
  const [settings, setSettings] = useState<Settings>(loadSettings);
  const initial = useMemo(() => (settings.saveDraft ? loadDraft() : null) ?? SAMPLE, []); // eslint-disable-line react-hooks/exhaustive-deps
  const checker = useChecker(initial, settings);
  const { doc, docRef, visible } = checker;
  const editor = useRef<EditorHandle>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [toast, setToast] = useState<Toast | null>(null);
  const [aiTask, setAiTask] = useState<AiTask>('grammar');
  const [aiBusy, setAiBusy] = useState(false);
  const aiAbort = useRef<AbortController | null>(null);
  const toastTimer = useRef<number | undefined>(undefined);

  const updateSettings = useCallback((next: Settings) => {
    setSettings(next);
    saveSettings(next);
  }, []);

  const showToast = useCallback((t: Toast) => {
    setToast(t);
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 6000);
  }, []);

  // Autosave the draft locally (debounced). Never leaves the browser.
  useEffect(() => {
    if (!settings.saveDraft) return;
    const t = window.setTimeout(() => saveDraft(doc.text), 500);
    return () => window.clearTimeout(t);
  }, [doc.text, settings.saveDraft]);

  // Phones: the list sits below the text, so offer a jump button while it's out of view.
  const [listInView, setListInView] = useState(true);
  useEffect(() => {
    const list = document.getElementById('suggestions');
    if (!list || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver(([e]) => setListInView(!!e?.isIntersecting), { rootMargin: '0px 0px -80px 0px' });
    io.observe(list);
    return () => io.disconnect();
  }, []);

  // Drop the active card if its suggestion disappeared.
  useEffect(() => {
    if (activeId && !visible.some((s) => s.id === activeId)) setActiveId(null);
  }, [visible, activeId]);

  /** Replace through the textarea so the browser's own undo stack (Cmd/Ctrl+Z) records it. */
  const replaceRange = (ta: HTMLTextAreaElement, start: number, end: number, replacement: string) => {
    ta.focus({ preventScroll: true });
    ta.setSelectionRange(start, end);
    const ok =
      replacement === '' ? document.execCommand('delete') : document.execCommand('insertText', false, replacement);
    if (!ok) {
      ta.setRangeText(replacement, start, end, 'end');
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    }
  };

  const accept = useCallback(
    (s: Suggestion, index: number) => {
      const ta = editor.current?.textarea;
      const replacement = s.replacements[index];
      if (!ta || replacement === undefined) return;
      const current = docRef.current;
      if (s.documentVersion !== current.version || !isApplicable(current, s) || ta.value !== current.text) {
        showToast({ message: 'That suggestion is out of date — the text changed. Rechecking…' });
        return;
      }
      replaceRange(ta, s.start, s.end, replacement);
      setActiveId(null);
      showToast({ message: `Changed “${s.original}” to “${replacement || '(removed)'}”`, undo: true });
    },
    [docRef, showToast],
  );

  const acceptAllSpelling = useCallback(() => {
    const ta = editor.current?.textarea;
    if (!ta) return;
    const fixes = visible
      .filter((s) => s.category === 'spelling' && s.source === 'harper' && s.replacements[0] !== undefined)
      .sort((a, b) => b.start - a.start); // back to front keeps earlier offsets valid
    let n = 0;
    for (const s of fixes) {
      if (ta.value.slice(s.start, s.end) !== s.original) continue;
      replaceRange(ta, s.start, s.end, s.replacements[0]!);
      n++;
    }
    showToast({ message: `Fixed ${n} spelling mistake${n === 1 ? '' : 's'}`, undo: n > 0 });
  }, [visible, showToast]);

  /** Swap the whole text (Clear / Example) through the textarea so Cmd/Ctrl+Z brings the old text back. */
  const replaceAllText = useCallback(
    (next: string, message: string) => {
      const ta = editor.current?.textarea;
      if (!ta) return;
      replaceRange(ta, 0, ta.value.length, next);
      ta.setSelectionRange(next === '' ? 0 : next.length, next === '' ? 0 : next.length);
      ta.scrollTop = 0;
      setActiveId(null);
      showToast({ message, undo: true });
    },
    [showToast],
  );

  const undo = () => {
    const ta = editor.current?.textarea;
    if (!ta) return;
    ta.focus();
    document.execCommand('undo');
    setToast(null);
  };

  const dismiss = useCallback(
    (s: Suggestion) => {
      checker.dismiss(s);
      setActiveId(null);
    },
    [checker],
  );

  const addWord = useCallback(
    (s: Suggestion) => {
      const word = s.original.trim();
      if (!word || settings.dictionary.includes(word)) return;
      updateSettings({ ...settings, dictionary: [...settings.dictionary, word].sort() });
      setActiveId(null);
      showToast({ message: `Added “${word}” to your dictionary` });
    },
    [settings, updateSettings, showToast],
  );

  const disableRule = useCallback(
    (s: Suggestion) => {
      if (settings.disabledRules.includes(s.rule)) return;
      updateSettings({ ...settings, disabledRules: [...settings.disabledRules, s.rule] });
      setActiveId(null);
      showToast({ message: `Turned off “${s.rule}”. Turn it back on in Settings.` });
    },
    [settings, updateSettings, showToast],
  );

  const activate = useCallback(
    (id: string | null) => {
      setActiveId(id);
      const s = id ? visible.find((x) => x.id === id) : null;
      if (s && editor.current?.textarea && document.activeElement !== editor.current.textarea) {
        // Clicking a sidebar card: show where it is without stealing the caret position permanently.
        editor.current.textarea.focus({ preventScroll: true });
        editor.current.textarea.setSelectionRange(s.end, s.end);
        document.querySelector(`[data-id="${CSS.escape(s.id)}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      }
    },
    [visible],
  );

  const aiReady = settings.aiEnabled && settings.aiEndpoint !== '' && settings.aiToken !== '';

  const runAi = async () => {
    if (aiBusy) {
      aiAbort.current?.abort();
      return;
    }
    if (!aiReady) {
      setSettingsOpen(true);
      return;
    }
    const ctrl = new AbortController();
    aiAbort.current = ctrl;
    setAiBusy(true);
    const result = await runAiCheck({
      endpoint: settings.aiEndpoint,
      token: settings.aiToken,
      doc: docRef.current,
      caret: editor.current?.textarea?.selectionStart ?? 0,
      task: aiTask,
      mode: settings.mode,
      signal: ctrl.signal,
    });
    setAiBusy(false);
    if (!result.ok) {
      showToast({ message: result.message });
      return;
    }
    checker.addAi(result.suggestions);
    const extra = result.dropped ? ` (${result.dropped} unsafe edit${result.dropped === 1 ? '' : 's'} discarded)` : '';
    showToast({
      message:
        result.suggestions.length === 0
          ? `AI found nothing to change${extra}.`
          : `AI suggested ${result.suggestions.length} edit${result.suggestions.length === 1 ? '' : 's'}${extra}.`,
    });
  };

  const stats = useMemo(() => textStats(doc.text), [doc.text]);
  const statusText =
    checker.status === 'loading'
      ? 'Loading checker…'
      : checker.status === 'error'
        ? 'Couldn’t load the checker'
        : checker.status === 'checking'
          ? 'Checking…'
          : `Checked on this device${checker.lastCheckMs !== null ? ` · ${checker.lastCheckMs} ms` : ''}`;

  return (
    <div className="app">
      <header className="topbar">
        <a className="brand" href={HOME_URL} title="GrammarMe home page">
          <svg viewBox="0 0 32 32" width="26" height="26" aria-hidden="true">
            <rect width="32" height="32" rx="8" fill="var(--brand)" />
            <path d="M21.5 11.2A7 7 0 1 0 23 17h-6.5" fill="none" stroke="#fff" strokeWidth="3" strokeLinecap="round" />
          </svg>
          <span>GrammarMe</span>
        </a>

        <div className="modes" role="radiogroup" aria-label="Writing mode">
          {MODES.map((m) => (
            <button
              key={m.id}
              type="button"
              role="radio"
              aria-checked={settings.mode === m.id}
              title={m.hint}
              className={`mode${settings.mode === m.id ? ' is-on' : ''}`}
              onClick={() => updateSettings({ ...settings, mode: m.id })}
            >
              {m.label}
            </button>
          ))}
        </div>

        <div className="topbar-actions">
          {settings.aiEnabled && (
            <div className="ai-run">
              <select
                aria-label="AI check type"
                value={aiTask}
                onChange={(e) => setAiTask(e.target.value as AiTask)}
                disabled={aiBusy}
              >
                <option value="grammar">Grammar</option>
                <option value="clarity">Clarity</option>
                <option value="tone">Tone</option>
              </select>
              <button type="button" className="btn btn-ai" onClick={runAi} aria-busy={aiBusy}>
                {aiBusy ? 'Cancel' : 'AI check'}
              </button>
            </div>
          )}
          <button
            type="button"
            className="btn btn-quiet"
            title="Empty the editor so you can type or paste your own text"
            disabled={doc.text === ''}
            onClick={() => replaceAllText('', 'Editor cleared. Type or paste your own text.')}
          >
            Clear
          </button>
          <button
            type="button"
            className="btn btn-quiet"
            title="Put back the example paragraph with a few mistakes"
            disabled={doc.text === SAMPLE}
            onClick={() => replaceAllText(SAMPLE, 'Example text restored.')}
          >
            Example
          </button>
          <button type="button" className="btn btn-quiet" onClick={() => setSettingsOpen(true)}>
            Settings
          </button>
        </div>
      </header>

      <main className="layout">
        <section className="page" aria-label="Editor">
          <Editor
            ref={editor}
            text={doc.text}
            suggestions={visible}
            activeId={activeId}
            onInput={checker.update}
            onActivate={setActiveId}
            onAccept={accept}
            onDismiss={dismiss}
            onAddWord={addWord}
            onDisableRule={disableRule}
            placeholder="Start writing, or paste your text…"
          />
          <footer className="page-foot">
            <span className={`status status-${checker.status}`} role="status" aria-live="polite">
              <span className="status-dot" aria-hidden="true" />
              {statusText}
            </span>
            <span className="stats">
              {stats.words} words · {Math.max(1, Math.round(stats.readingMinutes))} min read ·{' '}
              <span title={stats.readability === null ? '' : `Flesch reading ease ${stats.readability}`}>
                {readabilityLabel(stats.readability)}
              </span>
            </span>
          </footer>
        </section>

        <Sidebar
          suggestions={visible}
          activeId={activeId}
          onActivate={activate}
          onAccept={accept}
          onDismiss={dismiss}
          onAddWord={addWord}
          onDisableRule={disableRule}
          onAcceptAllSpelling={acceptAllSpelling}
          status={checker.status}
        />
      </main>

      {!listInView && visible.length > 0 && !toast && (
        <button
          type="button"
          className="jump"
          onClick={() => document.getElementById('suggestions')?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
        >
          {visible.length} suggestion{visible.length === 1 ? '' : 's'} ↓
        </button>
      )}

      <div className="toast-region" aria-live="polite">
        {toast && (
          <div className="toast">
            <span>{toast.message}</span>
            {toast.undo && (
              <button type="button" className="link link-invert" onClick={undo}>
                Undo
              </button>
            )}
          </div>
        )}
      </div>

      <SettingsDialog
        open={settingsOpen}
        settings={settings}
        onClose={() => setSettingsOpen(false)}
        onChange={updateSettings}
        onClearDraft={() => {
          saveDraft(null);
          showToast({ message: 'Saved draft deleted from this browser.' });
        }}
      />
    </div>
  );
}
