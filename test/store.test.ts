import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../src/lib/rubric-config';
import { InMemoryKV, ScoreStore } from '../src/lib/store';
import type { StoredScore } from '../src/lib/types';

function record(issueKey: string, projectKey: string, score = 90): StoredScore {
  return {
    issueKey,
    projectKey,
    summary: `Summary for ${issueKey}`,
    statusName: 'To Do',
    statusCategory: 'new',
    score,
    grade: 'ready',
    checks: [],
    issueUpdated: '2026-11-17T10:00:00.000Z',
    computedAt: '2026-11-17T10:05:00.000Z',
    settingsFingerprint: 'fp',
  };
}

describe('ScoreStore', () => {
  it('saves and returns a score, registering the project index', async () => {
    const store = new ScoreStore(new InMemoryKV());
    await store.saveScore(record('RS-1', 'RS'));
    await store.saveScore(record('RS-2', 'RS'));
    await store.saveScore(record('OPS-1', 'OPS', 40));

    expect((await store.getScore('RS-1'))?.score).toBe(90);
    expect(await store.getScore('MISSING-1')).toBeUndefined();
    const rsScores = await store.getProjectScores('RS');
    expect(rsScores.map((candidate) => candidate.issueKey).sort()).toEqual(['RS-1', 'RS-2']);
    expect(await store.getKnownProjects()).toEqual(['RS', 'OPS']);
  });

  it('does not duplicate index entries when a score is recomputed', async () => {
    const store = new ScoreStore(new InMemoryKV());
    await store.saveScore(record('RS-1', 'RS', 50));
    await store.saveScore(record('RS-1', 'RS', 75));
    expect(await store.getProjectScores('RS')).toHaveLength(1);
    expect((await store.getScore('RS-1'))?.score).toBe(75);
    expect(await store.getKnownProjects()).toEqual(['RS']);
  });

  it('returns default settings when none are stored', async () => {
    const store = new ScoreStore(new InMemoryKV());
    expect(await store.getSettings('RS')).toEqual(DEFAULT_SETTINGS);
  });

  it('round-trips saved settings and merges partial stored values over defaults', async () => {
    const kv = new InMemoryKV();
    const store = new ScoreStore(kv);
    const custom = {
      ...DEFAULT_SETTINGS,
      readyThreshold: 70,
      checksEnabled: { estimate: false, 'due-date': true },
    };
    await store.saveSettings('RS', custom);
    expect(await store.getSettings('RS')).toEqual(custom);

    // A partially-populated stored object (older shape) merges over defaults.
    await kv.set('settings:OPS', { readyThreshold: 66 });
    const merged = await store.getSettings('OPS');
    expect(merged.readyThreshold).toBe(66);
    expect(merged.almostThreshold).toBe(DEFAULT_SETTINGS.almostThreshold);
    expect(merged.checksEnabled).toEqual(DEFAULT_SETTINGS.checksEnabled);
  });

  it('manages rescan checkpoints', async () => {
    const store = new ScoreStore(new InMemoryKV());
    expect(await store.getRescanCheckpoint('RS')).toBeUndefined();
    await store.setRescanCheckpoint('RS', { nextStartAt: 100 });
    expect(await store.getRescanCheckpoint('RS')).toEqual({ nextStartAt: 100 });
    await store.clearRescanCheckpoint('RS');
    expect(await store.getRescanCheckpoint('RS')).toBeUndefined();
  });

  it('isolates stored values from caller mutation (KVS serialization semantics)', async () => {
    const kv = new InMemoryKV();
    await kv.set('k', { nested: { n: 1 } });
    const first = await kv.get<{ nested: { n: number } }>('k');
    if (!first) throw new Error('missing value');
    first.nested.n = 999;
    const second = await kv.get<{ nested: { n: number } }>('k');
    expect(second?.nested.n).toBe(1);
  });
});
