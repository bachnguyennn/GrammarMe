/** A resettable inactivity timer (used by the offscreen document to ask to be closed). */
export interface IdleTimer {
  /** Activity happened: restart the countdown. */
  touch(): void;
  stop(): void;
}

export function createIdleTimer(ms: number, onIdle: () => void): IdleTimer {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const stop = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
  return {
    touch() {
      stop();
      timer = setTimeout(() => {
        timer = null;
        onIdle();
      }, ms);
    },
    stop,
  };
}
