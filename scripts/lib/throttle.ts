/**
 * Sliding-window rate limiter, ported from the idea in
 * simonmysun/telegram-summarize-bot's throttle.py but generalized:
 *
 *   - at most `maxPerWindow` calls within any `windowMs` period, and
 *   - at least `minIntervalMs` between two consecutive calls.
 *
 * `acquire()` resolves once it is safe to proceed, sleeping as needed. It is
 * async (does not block the event loop) and safe to interleave across many
 * concurrent callers: permits are serialized so bursts are smoothed.
 *
 * A `now`/`sleep` pair can be injected for deterministic tests.
 */

export interface ThrottleOptions {
  maxPerWindow: number;
  windowMs: number;
  minIntervalMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, Math.max(0, ms)));

export class Throttle {
  private readonly maxPerWindow: number;
  private readonly windowMs: number;
  private readonly minIntervalMs: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  /** Timestamps of recent calls (within the window). */
  private history: number[] = [];
  /** Serializes acquire() so concurrent callers don't all pass at once. */
  private chain: Promise<void> = Promise.resolve();

  constructor(opts: ThrottleOptions) {
    if (opts.maxPerWindow < 1) throw new Error("maxPerWindow must be >= 1");
    if (opts.windowMs <= 0) throw new Error("windowMs must be > 0");
    this.maxPerWindow = opts.maxPerWindow;
    this.windowMs = opts.windowMs;
    this.minIntervalMs = opts.minIntervalMs ?? 0;
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? defaultSleep;
  }

  private prune(now: number): void {
    const cutoff = now - this.windowMs;
    this.history = this.history.filter((t) => t > cutoff);
  }

  /** Milliseconds to wait right now before a call would be allowed. */
  private delayMs(now: number): number {
    this.prune(now);
    let wait = 0;

    // Min-interval constraint.
    if (this.minIntervalMs > 0 && this.history.length > 0) {
      const last = this.history[this.history.length - 1]!;
      const since = now - last;
      if (since < this.minIntervalMs) wait = Math.max(wait, this.minIntervalMs - since);
    }

    // Window-count constraint: if full, wait until the oldest falls out.
    if (this.history.length >= this.maxPerWindow) {
      const oldest = this.history[0]!;
      wait = Math.max(wait, oldest + this.windowMs - now);
    }

    return wait;
  }

  /** Wait until it is safe to proceed, then record the call. */
  async acquire(): Promise<void> {
    // Serialize acquisitions through a promise chain.
    const prev = this.chain;
    let release!: () => void;
    this.chain = new Promise<void>((r) => (release = r));
    try {
      await prev;
      // Loop because after sleeping, other constraints may have shifted.
      for (;;) {
        const now = this.now();
        const wait = this.delayMs(now);
        if (wait <= 0) break;
        await this.sleep(wait);
      }
      this.history.push(this.now());
    } finally {
      release();
    }
  }

  /** For diagnostics/tests: number of calls currently within the window. */
  get windowCount(): number {
    this.prune(this.now());
    return this.history.length;
  }
}
