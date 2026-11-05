/**
 * Debounced, version-gated checking. Pure (no DOM, no chrome.*): timers are global
 * setTimeout/clearTimeout so tests can use fake timers.
 *
 * Rules:
 *  - A check runs `delayMs` after the last `schedule()` call (typing pause).
 *  - At most one request is in flight; if the text changes meanwhile, another check is queued
 *    for when the first returns (never more than one queued).
 *  - A result for an older version is rebased onto the current text (so underlines appear without
 *    waiting for another round-trip); a result older than one already delivered is dropped.
 */
import { rebaseSuggestions, type DocumentSnapshot, type Suggestion } from '@grammarme/core';

export interface SchedulerOptions {
  delayMs: number;
  /** Read the field's current text + version. */
  current: () => DocumentSnapshot;
  /** Ask the engine. Resolve null to mean "no result" (error/disabled) — nothing is delivered. */
  check: (snapshot: DocumentSnapshot) => Promise<Suggestion[] | null>;
  /** Suggestions valid for `snapshot` (always the current text at delivery time). */
  onResult: (snapshot: DocumentSnapshot, suggestions: Suggestion[]) => void;
  /** Should this snapshot be checked at all (e.g. empty or too long)? Default: always. */
  shouldCheck?: (snapshot: DocumentSnapshot) => boolean;
  onBusyChange?: (busy: boolean) => void;
}

export class CheckScheduler {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inFlight = false;
  private rerun = false;
  private disposed = false;
  /** Highest version a result has been delivered for (or skipped as not checkable). */
  private settledVersion = -1;

  constructor(private readonly opts: SchedulerOptions) {}

  /** The text changed: (re)start the debounce timer. */
  schedule(): void {
    if (this.disposed) return;
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.run();
    }, this.opts.delayMs);
  }

  /** Check immediately (focus, settings change). `force` re-checks an already checked version. */
  runNow(force = false): void {
    if (this.disposed) return;
    this.clearTimer();
    if (force) this.settledVersion = -1;
    void this.run();
  }

  /** True when the latest text still needs a check result. */
  get pending(): boolean {
    return this.timer !== null || this.inFlight;
  }

  dispose(): void {
    this.disposed = true;
    this.clearTimer();
  }

  private clearTimer(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  private async run(): Promise<void> {
    if (this.disposed) return;
    if (this.inFlight) {
      this.rerun = true;
      return;
    }
    const snap = this.opts.current();
    if (snap.version <= this.settledVersion) return; // already checked this exact text
    if (this.opts.shouldCheck && !this.opts.shouldCheck(snap)) {
      this.settledVersion = snap.version;
      this.opts.onResult(snap, []);
      return;
    }
    this.inFlight = true;
    this.opts.onBusyChange?.(true);
    let result: Suggestion[] | null = null;
    try {
      result = await this.opts.check(snap);
    } catch {
      result = null;
    } finally {
      this.inFlight = false;
    }
    if (this.disposed) return;
    const now = this.opts.current();
    if (result && snap.version > this.settledVersion) {
      this.settledVersion = snap.version;
      this.opts.onResult(now, reconcile(snap, now, result));
    }
    if (this.rerun || now.version !== snap.version) {
      this.rerun = false;
      // A newer edit is waiting; if its debounce timer is still running let it fire, else run now.
      if (this.timer === null) void this.run();
    } else {
      this.opts.onBusyChange?.(false);
    }
  }
}

/** Move suggestions computed for `sent` onto `current` (no-op when versions match). */
export function reconcile(sent: DocumentSnapshot, current: DocumentSnapshot, suggestions: Suggestion[]): Suggestion[] {
  if (current.version === sent.version && current.text === sent.text) {
    return suggestions.map((s) => (s.documentVersion === sent.version ? s : { ...s, documentVersion: sent.version }));
  }
  if (current.version < sent.version) return [];
  return rebaseSuggestions(sent.text, current, suggestions);
}
