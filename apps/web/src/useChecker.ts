import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { rebaseSuggestions, resolveOverlaps, type DocumentSnapshot, type Suggestion } from '@grammarme/core';
import { getEngine } from './engine.ts';
import { dismissKey, groupOf } from './segments.ts';
import type { Settings } from './storage.ts';

export type CheckStatus = 'loading' | 'checking' | 'ready' | 'error';

const DEBOUNCE_MS = 300;
/** Words that should never be flagged, on top of the user's dictionary. */
const BUILTIN_WORDS = ['GrammarMe'];

/**
 * Owns the document version counter and both suggestion sources.
 * - Every edit bumps the version and rebases existing underlines (no flicker while typing).
 * - Harper runs debounced; a late result is rebased onto the current text, never applied blindly.
 */
export function useChecker(initialText: string, settings: Settings) {
  const [doc, setDoc] = useState<DocumentSnapshot>({ text: initialText, version: 0 });
  const docRef = useRef(doc);
  const [harper, setHarper] = useState<Suggestion[]>([]);
  const [ai, setAi] = useState<Suggestion[]>([]);
  const [dismissed, setDismissed] = useState<Set<string>>(() => new Set());
  const [status, setStatus] = useState<CheckStatus>('loading');
  const [lastCheckMs, setLastCheckMs] = useState<number | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  const runCheck = useCallback(async () => {
    const snapshot = docRef.current;
    setStatus((s) => (s === 'loading' ? s : 'checking'));
    const started = performance.now();
    try {
      const result = await getEngine().check(snapshot, {
        dialect: settingsRef.current.dialect,
        disabledRules: settingsRef.current.disabledRules,
      });
      setLastCheckMs(Math.round(performance.now() - started));
      const current = docRef.current;
      // The user may have kept typing; map the result onto the current text (drops anything touched).
      setHarper(current.version === snapshot.version ? result : rebaseSuggestions(snapshot.text, current, result));
      setStatus('ready');
    } catch (err) {
      console.error('[GrammarMe] check failed', err);
      setStatus('error');
    }
  }, []);

  const schedule = useCallback(
    (delay = DEBOUNCE_MS) => {
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => void runCheck(), delay);
    },
    [runCheck],
  );

  /** Call with the textarea's new value after any edit (typing, paste, accept, undo). */
  const update = useCallback(
    (text: string) => {
      const prev = docRef.current;
      if (text === prev.text) return;
      const next = { text, version: prev.version + 1 };
      docRef.current = next;
      setDoc(next);
      setHarper((list) => rebaseSuggestions(prev.text, next, list));
      setAi((list) => rebaseSuggestions(prev.text, next, list));
      schedule();
    },
    [schedule],
  );

  // First check (also warms up the WASM), and re-check when settings that affect Harper change.
  const rulesKey = settings.disabledRules.join('|');
  useEffect(() => {
    schedule(0);
  }, [schedule, settings.dialect, rulesKey]);

  const dictKey = settings.dictionary.join('\n');
  useEffect(() => {
    const words = dictKey ? dictKey.split('\n') : [];
    void getEngine()
      .setDictionary([...BUILTIN_WORDS, ...words])
      .then(() => schedule(0))
      .catch(() => {
        /* a load failure is reported by the check itself (status "error") */
      });
  }, [schedule, dictKey]);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  const dismiss = useCallback((s: Suggestion) => {
    setDismissed((d) => new Set(d).add(dismissKey(docRef.current.text, s)));
  }, []);

  const addAi = useCallback((list: Suggestion[]) => {
    const current = docRef.current;
    setAi(list.filter((s) => s.documentVersion === current.version));
  }, []);

  const clearAi = useCallback(() => setAi([]), []);

  const visible = useMemo(() => {
    const dict = new Set(settings.dictionary.map((w) => w.toLowerCase()));
    const filtered = [...harper, ...ai].filter((s) => {
      if (dismissed.has(dismissKey(doc.text, s))) return false;
      if (s.category === 'spelling' && dict.has(s.original.toLowerCase())) return false;
      // Casual mode: keep correctness, hide stylistic nitpicks.
      if (settings.mode === 'casual' && groupOf(s) === 'style') return false;
      return true;
    });
    return resolveOverlaps(filtered).filter((s) => s.documentVersion === doc.version);
  }, [harper, ai, dismissed, doc, settings.dictionary, settings.mode]);

  return { doc, docRef, update, visible, status, lastCheckMs, dismiss, addAi, clearAi, aiCount: ai.length };
}
