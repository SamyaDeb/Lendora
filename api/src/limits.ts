import {createHash} from "node:crypto";
import type {Redis} from "ioredis";

/**
 * SI-R10 limits. Free tier (no key): 60 requests/min and 1 WebSocket connection per client IP. Keyed tier: 600/min
 * and 10 connections per key. Counters use a fixed 60 s window. Client IPs are only used as hashed, expiring counter
 * keys (never stored with a wallet, APP-R11).
 */
export interface HitResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  /** Unix seconds when the window resets. */
  reset: number;
}

export interface Limiter {
  hit(key: string, limit: number, windowSec?: number): Promise<HitResult>;
  /** Try to take a connection slot; false when `max` are in use. */
  acquire(key: string, max: number): Promise<boolean>;
  release(key: string): Promise<void>;
}

export const clientKey = (ip: string) => `ip:${createHash("sha256").update(ip).digest("hex").slice(0, 24)}`;

export class MemoryLimiter implements Limiter {
  private readonly windows = new Map<string, {count: number; reset: number}>();
  private readonly conns = new Map<string, number>();
  constructor(private readonly now: () => number = () => Math.floor(Date.now() / 1000)) {}

  async hit(key: string, limit: number, windowSec = 60): Promise<HitResult> {
    const t = this.now();
    let w = this.windows.get(key);
    if (!w || w.reset <= t) {
      w = {count: 0, reset: t - (t % windowSec) + windowSec};
      this.windows.set(key, w);
    }
    w.count++;
    return {allowed: w.count <= limit, limit, remaining: Math.max(0, limit - w.count), reset: w.reset};
  }

  async acquire(key: string, max: number): Promise<boolean> {
    const n = this.conns.get(key) ?? 0;
    if (n >= max) return false;
    this.conns.set(key, n + 1);
    return true;
  }

  async release(key: string): Promise<void> {
    const n = (this.conns.get(key) ?? 1) - 1;
    if (n <= 0) this.conns.delete(key);
    else this.conns.set(key, n);
  }
}

/** Shared across API instances. Connection slots expire after an hour as a safety net against crashed instances. */
export class RedisLimiter implements Limiter {
  constructor(
    private readonly redis: Redis,
    private readonly prefix = "stockline:rl:",
  ) {}

  async hit(key: string, limit: number, windowSec = 60): Promise<HitResult> {
    const t = Math.floor(Date.now() / 1000);
    const bucket = t - (t % windowSec);
    const k = `${this.prefix}${key}:${bucket}`;
    const res = await this.redis.multi().incr(k).expire(k, windowSec + 5).exec();
    const count = Number(res?.[0]?.[1] ?? 0);
    return {allowed: count <= limit, limit, remaining: Math.max(0, limit - count), reset: bucket + windowSec};
  }

  async acquire(key: string, max: number): Promise<boolean> {
    const k = `${this.prefix}ws:${key}`;
    const n = await this.redis.incr(k);
    await this.redis.expire(k, 3600);
    if (n > max) {
      await this.redis.decr(k);
      return false;
    }
    return true;
  }

  async release(key: string): Promise<void> {
    const k = `${this.prefix}ws:${key}`;
    const n = await this.redis.decr(k);
    if (n <= 0) await this.redis.del(k);
  }
}
