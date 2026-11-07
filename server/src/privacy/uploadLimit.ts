/**
 * Per-key fixed-window counter (in memory; the API runs as a single instance).
 * Used to cap audio uploads per phone so a runaway or stolen device can't fill the disk.
 */
export class WindowLimiter {
  private readonly hits = new Map<string, { start: number; count: number }>();

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Counts one hit; returns seconds until the window resets when over the limit, else 0. */
  take(key: string): number {
    const t = this.now();
    let w = this.hits.get(key);
    if (!w || t - w.start >= this.windowMs) {
      w = { start: t, count: 0 };
      this.hits.set(key, w);
      if (this.hits.size > 10_000) this.prune(t);
    }
    if (w.count >= this.max) return Math.max(1, Math.ceil((w.start + this.windowMs - t) / 1000));
    w.count++;
    return 0;
  }

  private prune(t: number) {
    for (const [k, w] of this.hits) if (t - w.start >= this.windowMs) this.hits.delete(k);
  }
}
