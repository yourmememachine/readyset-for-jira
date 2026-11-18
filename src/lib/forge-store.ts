/**
 * Production {@link KeyValueStore} backed by Forge KVS (`@forge/api`
 * storage). All ReadySet data stays on Atlassian — no external backend.
 */
import { storage } from '@forge/api';
import type { KeyValueStore } from './store';

export class ForgeKV implements KeyValueStore {
  async get<T>(key: string): Promise<T | undefined> {
    const value = await storage.get(key);
    return value === undefined ? undefined : (value as T);
  }

  async set(key: string, value: unknown): Promise<void> {
    // Forge KVS accepts JSON-shaped values; everything ScoreStore writes
    // (records, string arrays, settings, checkpoints) qualifies.
    await storage.set(key, value as Parameters<typeof storage.set>[1]);
  }

  async delete(key: string): Promise<void> {
    await storage.delete(key);
  }
}
