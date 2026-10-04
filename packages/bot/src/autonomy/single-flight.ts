/**
 * At most one task of this kind in flight at a time.
 *
 * The trading head has exactly one invariant that two concurrent passes would
 * break: both would read the same book, the same day's opening budget and the
 * same exposure headroom, and size two entries against room for one. The timer
 * used to guard this with a flag it owned - but the dashboard's `runNow`
 * bypassed it entirely, so an operator pressing the button during a slow pass
 * got a second head running on top of the first.
 *
 * The flag now lives in one object every caller has to go through, and a
 * caller that arrives while a pass is running is *answered* rather than
 * queued: skipping is always safe here, because the pass that is already
 * running will make its own decision from fresher data a minute later anyway.
 */
export class SingleFlight<T> {
  private inflight: Promise<T> | null = null;

  constructor(private readonly onSkip: () => T) {}

  /** Whether a task is currently running. */
  busy(): boolean {
    return this.inflight !== null;
  }

  /**
   * Run `task`, or report `onSkip` when one is already running.
   *
   * The lock is released on success *and* on failure - a rejected task that
   * latched the gate closed would stop the desk for good, which is the one
   * outcome worse than a slow one.
   */
  run(task: () => Promise<T>): Promise<T> {
    if (this.inflight) return Promise.resolve(this.onSkip());

    const started = Promise.resolve().then(task);
    this.inflight = started.then(
      (value) => {
        this.inflight = null;
        return value;
      },
      (error) => {
        this.inflight = null;
        throw error;
      },
    );

    return this.inflight;
  }
}