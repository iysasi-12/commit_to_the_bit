import { Errors } from "./errors.ts";

/**
 * In-memory sliding-window limiter. Good for one server process; a multi-instance
 * deployment would need a shared store (e.g. Redis) instead.
 */
export class RateLimiter {
  private readonly hits = new Map<string, number[]>();
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  /** Records one use, or throws RATE_LIMITED when the window is full. */
  consume(key: string, limit: number, windowMs: number, what: string): void {
    const now = this.now();
    const fresh = (this.hits.get(key) ?? []).filter((t) => now - t < windowMs);
    if (fresh.length >= limit) {
      const retryAfterMs = windowMs - (now - fresh[0]!);
      this.hits.set(key, fresh);
      throw Errors.rateLimited(Math.ceil(retryAfterMs / 1000), what);
    }
    fresh.push(now);
    this.hits.set(key, fresh);
  }

  reset(): void {
    this.hits.clear();
  }
}

export const HOUR = 3600_000;
export const DAY = 24 * HOUR;
export const MINUTE = 60_000;
