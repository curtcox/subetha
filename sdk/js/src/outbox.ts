// Store-and-forward outbox with exponential backoff and persistence (PLAN §1, §5, §10).
// Mirrors sdk/core/src/store.rs so browser/Node/edge apps get the same offline reliability.
import { ulid, type Envelope } from "./protocol/index.ts";

export interface RetryPolicy {
  baseMs: number;
  maxMs: number;
  maxAttempts?: number;
  capacity: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  baseMs: 1_000,
  maxMs: 60_000,
  capacity: 1_000,
};

export interface OutboxItem {
  id: string;
  envelope: Envelope;
  attempts: number;
  enqueuedMs: number;
  nextAttemptMs: number;
  expiresMs?: number;
}

export class Outbox {
  readonly policy: RetryPolicy;
  private items = new Map<string, OutboxItem>();
  private order: string[] = [];

  constructor(policy: Partial<RetryPolicy> = {}) {
    this.policy = { ...DEFAULT_RETRY_POLICY, ...policy };
  }

  get size(): number {
    return this.items.size;
  }

  backoffMs(attempts: number): number {
    const exp = Math.min(Math.max(attempts - 1, 0), 30);
    return Math.min(this.policy.maxMs, this.policy.baseMs * 2 ** exp);
  }

  /** Enqueues an envelope (assigning a ULID id if absent). Duplicate ids are ignored. */
  enqueue(envelope: Envelope, opts: { nowMs?: number; expiresMs?: number } = {}): OutboxItem {
    const nowMs = opts.nowMs ?? Date.now();
    const id = (envelope.id ?? ulid(nowMs)).toUpperCase();
    const existing = this.items.get(id);
    if (existing) return existing;
    const env: Envelope = { ...envelope, id };
    const expiresMs = opts.expiresMs ?? (env.expires ? env.expires * 1000 : undefined);
    const item: OutboxItem = { id, envelope: env, attempts: 0, enqueuedMs: nowMs, nextAttemptMs: nowMs, expiresMs };
    this.items.set(id, item);
    this.order.push(id);
    while (this.order.length > this.policy.capacity) {
      const drop = this.order.shift();
      if (drop) this.items.delete(drop);
    }
    return item;
  }

  /** Returns items ready to attempt at `nowMs`, advancing their attempt count and backoff. */
  poll(nowMs = Date.now()): OutboxItem[] {
    this.prune(nowMs);
    const due: OutboxItem[] = [];
    for (const id of this.order) {
      const it = this.items.get(id);
      if (!it) continue;
      if (it.nextAttemptMs > nowMs) continue;
      if (this.policy.maxAttempts !== undefined && it.attempts >= this.policy.maxAttempts) continue;
      it.attempts += 1;
      it.nextAttemptMs = nowMs + this.backoffMs(it.attempts);
      due.push({ ...it });
    }
    return due;
  }

  /** Removes a delivered item. Returns true if it was present. */
  ack(id: string): boolean {
    const key = id.toUpperCase();
    if (!this.items.delete(key)) return false;
    this.order = this.order.filter((x) => x !== key);
    return true;
  }

  /** Reschedules a failed item (optionally overriding backoff delay). */
  nack(id: string, retryAfterMs?: number, nowMs = Date.now()): boolean {
    const it = this.items.get(id.toUpperCase());
    if (!it) return false;
    it.nextAttemptMs = nowMs + (retryAfterMs ?? this.backoffMs(it.attempts));
    return true;
  }

  /** Removes expired or exhausted items. Returns count dropped. */
  prune(nowMs = Date.now()): number {
    let removed = 0;
    const kept: string[] = [];
    for (const id of this.order) {
      const it = this.items.get(id);
      if (!it) continue;
      const expired = it.expiresMs !== undefined && it.expiresMs <= nowMs;
      const exhausted = this.policy.maxAttempts !== undefined && it.attempts >= this.policy.maxAttempts;
      if (expired || exhausted) {
        this.items.delete(id);
        removed++;
      } else {
        kept.push(id);
      }
    }
    this.order = kept;
    return removed;
  }

  /** Attempts to deliver every due item via `send`, acking on success. */
  async flush(send: (env: Envelope) => Promise<unknown>, nowMs = Date.now()): Promise<{ sent: string[]; failed: { id: string; error: unknown }[] }> {
    const due = this.poll(nowMs);
    const sent: string[] = [];
    const failed: { id: string; error: unknown }[] = [];
    for (const it of due) {
      try {
        await send(it.envelope);
        this.ack(it.id);
        sent.push(it.id);
      } catch (error) {
        failed.push({ id: it.id, error });
      }
    }
    return { sent, failed };
  }

  toJSON(): { policy: RetryPolicy; items: OutboxItem[] } {
    return { policy: this.policy, items: this.order.map((id) => this.items.get(id)!).filter(Boolean) };
  }

  static fromJSON(data: { policy?: Partial<RetryPolicy>; items?: OutboxItem[] }): Outbox {
    const o = new Outbox(data.policy);
    for (const it of data.items ?? []) {
      const id = it.id.toUpperCase();
      o.items.set(id, { ...it, id });
      o.order.push(id);
    }
    return o;
  }
}
