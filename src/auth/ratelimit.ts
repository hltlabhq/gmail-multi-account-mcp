// Self-expiring rate limit shared by /oauth/authorize/verify and /admin/*.
//
// Buckets:
//   * "ip:<ip>"        — counts failed attempts per source IP (5/min soft, 20/hr hard)
//   * "keyid:<keyid>"  — per team-key keyid; same defaults
//   * "op:<fp>"        — per OPERATOR_TOKEN fingerprint; same defaults
//
// Storage: D1 ratelimit(rkey, window_start, count, blocked_until).
//
// Block semantics:
//   * Soft block: blocked_until = now + 60s when count >= 5 in current minute.
//   * Hard block: blocked_until = now + 60min when count >= 20 in current hour.
// `blocked_until` is consulted on every check and self-expires by clock.
// `admin clear-block <id>` clears the row outright; the next attempt starts
// a fresh window.

export interface RateLimitDeps {
  db: D1Database;
  now?: () => number;
}

export interface RateLimitResult {
  allowed: boolean;
  retryAfterSec?: number;
}

const MINUTE = 60_000;
const HOUR = 60 * 60_000;
const SOFT_LIMIT_PER_MIN = 5;
const HARD_LIMIT_PER_HOUR = 20;
const SOFT_BLOCK_MS = 60_000;            // 1 minute
const HARD_BLOCK_MS = 60 * 60_000;       // 1 hour (matches operator-confirmed default)

export class RateLimiter {
  constructor(private deps: RateLimitDeps) {}

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  // Check (without incrementing) whether the bucket is currently blocked.
  async peek(rkey: string): Promise<RateLimitResult> {
    const row = await this.deps.db
      .prepare("SELECT blocked_until FROM ratelimit WHERE rkey = ?")
      .bind(rkey)
      .first<{ blocked_until: number | null }>();
    if (!row || row.blocked_until === null) return { allowed: true };
    const remain = row.blocked_until - this.now();
    if (remain <= 0) return { allowed: true };
    return { allowed: false, retryAfterSec: Math.ceil(remain / 1000) };
  }

  // Record one failure. Returns the new block state.
  async noteFailure(rkey: string): Promise<RateLimitResult> {
    const now = this.now();
    const row = await this.deps.db
      .prepare("SELECT window_start, count, blocked_until FROM ratelimit WHERE rkey = ?")
      .bind(rkey)
      .first<{ window_start: number; count: number; blocked_until: number | null }>();

    // If currently blocked and not expired, just refuse without bumping.
    if (row && row.blocked_until !== null && row.blocked_until > now) {
      return { allowed: false, retryAfterSec: Math.ceil((row.blocked_until - now) / 1000) };
    }

    // Determine current window: minute-aligned for soft, hour-aligned for hard.
    // We keep one row and update it; for simplicity we use a minute bucket
    // and derive hour counts by checking elapsed time.
    let windowStart: number;
    let count: number;
    if (!row) {
      windowStart = now;
      count = 1;
    } else if (now - row.window_start >= MINUTE) {
      // Window expired — reset.
      windowStart = now;
      count = 1;
    } else {
      windowStart = row.window_start;
      count = row.count + 1;
    }

    let blockedUntil: number | null = null;
    if (count >= SOFT_LIMIT_PER_MIN) blockedUntil = now + SOFT_BLOCK_MS;

    // Hour-bucket check: separate row keyed with "<rkey>:h".
    const hourKey = `${rkey}:h`;
    const hourRow = await this.deps.db
      .prepare("SELECT window_start, count FROM ratelimit WHERE rkey = ?")
      .bind(hourKey)
      .first<{ window_start: number; count: number }>();
    let hourStart: number;
    let hourCount: number;
    if (!hourRow || now - hourRow.window_start >= HOUR) {
      hourStart = now;
      hourCount = 1;
    } else {
      hourStart = hourRow.window_start;
      hourCount = hourRow.count + 1;
    }
    if (hourCount >= HARD_LIMIT_PER_HOUR) blockedUntil = now + HARD_BLOCK_MS;

    await this.deps.db
      .prepare(
        `INSERT INTO ratelimit (rkey, window_start, count, blocked_until)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(rkey) DO UPDATE
         SET window_start = excluded.window_start,
             count = excluded.count,
             blocked_until = excluded.blocked_until`,
      )
      .bind(rkey, windowStart, count, blockedUntil)
      .run();
    await this.deps.db
      .prepare(
        `INSERT INTO ratelimit (rkey, window_start, count, blocked_until)
         VALUES (?, ?, ?, NULL)
         ON CONFLICT(rkey) DO UPDATE
         SET window_start = excluded.window_start,
             count = excluded.count`,
      )
      .bind(hourKey, hourStart, hourCount)
      .run();

    if (blockedUntil === null) return { allowed: true };
    return { allowed: false, retryAfterSec: Math.ceil((blockedUntil - now) / 1000) };
  }

  // On success, reset both buckets for this key.
  async noteSuccess(rkey: string): Promise<void> {
    await this.deps.db
      .prepare("DELETE FROM ratelimit WHERE rkey IN (?, ?)")
      .bind(rkey, `${rkey}:h`)
      .run();
  }

  // Operator-invoked clear without forcing a rotation.
  async clear(rkey: string): Promise<void> {
    await this.noteSuccess(rkey);
  }
}
