/**
 * Production {@link KeyValueStore} backed by `@forge/kvs`.
 *
 * Migrated from the legacy `@forge/api` storage module in cross-review
 * round 3 (B16): Atlassian froze feature updates to the legacy module
 * in March 2025 and directs new apps to `@forge/kvs` (which is also
 * the only module offering transactions). All ReadySet data stays on
 * Atlassian — no external backend.
 */
import { kvs, WhereConditions } from '@forge/kvs';
import type { KeyValueStore } from './store';

export class ForgeKV implements KeyValueStore {
  async get<T>(key: string): Promise<T | undefined> {
    return kvs.get<T>(key);
  }

  async set(key: string, value: unknown, options?: { ttlSeconds?: number }): Promise<void> {
    // TTL plumbing (round 2, D11/E12): @forge/kvs supports a
    // per-write TTL; only cache-class values (drafts, daily counters,
    // quotas) pass one — durable state never expires.
    if (options?.ttlSeconds !== undefined) {
      await kvs.set(key, value, {
        ttl: { value: options.ttlSeconds, unit: 'SECONDS' as const },
      });
      return;
    }
    await kvs.set(key, value);
  }

  async delete(key: string): Promise<void> {
    await kvs.delete(key);
  }

  async list(
    prefix: string,
    limit: number,
    cursor?: string,
  ): Promise<{ keys: string[]; nextCursor?: string }> {
    // KVS query is eventually consistent (documented): a membership
    // marker written a moment ago can be missing from one listing.
    // Accepted in cross-review A3 — the listing self-heals on the next
    // read, unlike the permanent loss of the old array index.
    const builder = kvs
      .query()
      .where('key', WhereConditions.beginsWith(prefix))
      .limit(limit);
    if (cursor) builder.cursor(cursor);
    const page = await builder.getMany();
    return {
      keys: page.results.map((result) => result.key),
      ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
    };
  }
}
