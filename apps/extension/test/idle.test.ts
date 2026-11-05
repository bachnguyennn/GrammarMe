import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createIdleTimer } from '../src/idle.ts';

describe('createIdleTimer', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('fires only after a full quiet period, and activity resets it', () => {
    const onIdle = vi.fn();
    const t = createIdleTimer(1000, onIdle);
    t.touch();
    vi.advanceTimersByTime(900);
    t.touch();
    vi.advanceTimersByTime(900);
    expect(onIdle).not.toHaveBeenCalled();
    vi.advanceTimersByTime(100);
    expect(onIdle).toHaveBeenCalledTimes(1);
    t.touch();
    t.stop();
    vi.advanceTimersByTime(5000);
    expect(onIdle).toHaveBeenCalledTimes(1);
  });
});
