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
  it('saves and returns a score under its project membership', async () => {
    const store = new ScoreStore(new InMemoryKV());
    await store.saveScore(record('RS-1', 'RS'));
    await store.saveScore(record('RS-2', 'RS'));
    await store.saveScore(record('OPS-1', 'OPS', 40));

    expect((await store.getScore('RS-1'))?.score).toBe(90);
    expect(await store.getScore('MISSING-1')).toBeUndefined();
    const rsScores = await store.getProjectScores('RS');
    expect(rsScores.map((candidate) => candidate.issueKey).sort()).toEqual(['RS-1', 'RS-2']);
  });

  it('B10: scoring an issue does NOT register the project for nightly rescan', async () => {
    const store = new ScoreStore(new InMemoryKV());
    await store.saveScore(record('RS-1', 'RS'));
    expect(await store.getKnownProjects()).toEqual([]);
    await store.registerProject('RS');
    await store.registerProject('OPS');
    expect(await store.getKnownProjects()).toEqual(['OPS', 'RS']);
  });

  it('does not duplicate membership when a score is recomputed', async () => {
    const store = new ScoreStore(new InMemoryKV());
    await store.saveScore(record('RS-1', 'RS', 50));
    await store.saveScore(record('RS-1', 'RS', 75));
    expect(await store.getProjectScores('RS')).toHaveLength(1);
    expect((await store.getScore('RS-1'))?.score).toBe(75);
  });

  it('A3: concurrent saveScore calls for different issues all survive', async () => {
    const store = new ScoreStore(new InMemoryKV());
    await Promise.all([
      store.saveScore(record('RS-1', 'RS')),
      store.saveScore(record('RS-2', 'RS')),
      store.saveScore(record('RS-3', 'RS')),
      store.saveScore(record('RS-4', 'RS')),
      store.saveScore(record('RS-5', 'RS')),
    ]);
    const scores = await store.getProjectScores('RS');
    expect(scores.map((candidate) => candidate.issueKey).sort()).toEqual([
      'RS-1',
      'RS-2',
      'RS-3',
      'RS-4',
      'RS-5',
    ]);
  });

  it('A2: moving an issue to another project drops the old membership at once', async () => {
    const store = new ScoreStore(new InMemoryKV());
    await store.saveScore(record('RS-1', 'RS'));
    await store.saveScore(record('RS-1', 'OPS'));
    expect(await store.getProjectScores('RS')).toEqual([]);
    expect((await store.getProjectScores('OPS')).map((r) => r.issueKey)).toEqual(['RS-1']);
  });

  it('B9: deleteScore removes the record and its membership', async () => {
    const store = new ScoreStore(new InMemoryKV());
    await store.saveScore(record('RS-1', 'RS'));
    await store.deleteScore('RS-1');
    expect(await store.getScore('RS-1')).toBeUndefined();
    expect(await store.getProjectScores('RS')).toEqual([]);
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
      checksEnabled: { estimate: false, 'due-date': true, 'repro-steps': true },
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

  it('A10: a stored ready threshold below the default clamps the merged almost threshold', async () => {
    const kv = new InMemoryKV();
    const store = new ScoreStore(kv);
    await kv.set('settings:RS', { readyThreshold: 40 });
    const merged = await store.getSettings('RS');
    expect(merged.readyThreshold).toBe(40);
    expect(merged.almostThreshold).toBeLessThanOrEqual(40);
  });

  it('manages rescan checkpoints (opaque token + seen set)', async () => {
    const store = new ScoreStore(new InMemoryKV());
    expect(await store.getRescanCheckpoint('RS')).toBeUndefined();
    await store.setRescanCheckpoint('RS', { nextPageToken: 'pg:100', seenKeys: ['RS-1'] });
    expect(await store.getRescanCheckpoint('RS')).toEqual({
      nextPageToken: 'pg:100',
      seenKeys: ['RS-1'],
    });
    await store.clearRescanCheckpoint('RS');
    expect(await store.getRescanCheckpoint('RS')).toBeUndefined();
  });

  it('manages scan state (three-state, cross-review A1)', async () => {
    const store = new ScoreStore(new InMemoryKV());
    expect(await store.getScanState('RS')).toBeUndefined();
    await store.setScanState('RS', { status: 'scanning', updatedAt: '2026-11-17T10:00:00.000Z' });
    expect((await store.getScanState('RS'))?.status).toBe('scanning');
    await store.setScanState('RS', {
      status: 'failed',
      updatedAt: '2026-11-17T10:01:00.000Z',
      error: 'HTTP 410',
    });
    expect((await store.getScanState('RS'))?.error).toBe('HTTP 410');
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

describe('score history (upgrade pack, review #3)', () => {
  it('seeds history with the first computed score', async () => {
    const kv = new InMemoryKV();
    const store = new ScoreStore(kv);
    await store.saveScore(record('RS-1', 'RS', 40));
    const saved = await store.getScore('RS-1');
    expect(saved?.history).toEqual([{ score: 40, grade: 'ready', at: saved?.computedAt }]);
  });

  it('appends only when the score value changes', async () => {
    const kv = new InMemoryKV();
    const store = new ScoreStore(kv);
    await store.saveScore(record('RS-1', 'RS', 40));
    await store.saveScore(record('RS-1', 'RS', 40));
    expect((await store.getScore('RS-1'))?.history).toHaveLength(1);
    await store.saveScore(record('RS-1', 'RS', 75));
    const history = (await store.getScore('RS-1'))?.history ?? [];
    expect(history.map((entry) => entry.score)).toEqual([40, 75]);
  });

  it('caps history at the latest 10 points', async () => {
    const kv = new InMemoryKV();
    const store = new ScoreStore(kv);
    for (let score = 1; score <= 12; score += 1) {
      await store.saveScore(record('RS-1', 'RS', score));
    }
    const history = (await store.getScore('RS-1'))?.history ?? [];
    expect(history).toHaveLength(10);
    expect(history[0]?.score).toBe(3);
    expect(history[history.length - 1]?.score).toBe(12);
  });

  it('a pre-upgrade record (no history) seeds from its own last score', async () => {
    const kv = new InMemoryKV();
    const store = new ScoreStore(kv);
    const legacy = record('RS-1', 'RS', 55);
    delete legacy.history;
    await kv.set('score:RS-1', legacy);
    await kv.set('idx:RS:RS-1', 1);
    await store.saveScore(record('RS-1', 'RS', 55));
    expect((await store.getScore('RS-1'))?.history?.map((entry) => entry.score)).toEqual([55]);
    await store.saveScore(record('RS-1', 'RS', 80));
    expect((await store.getScore('RS-1'))?.history?.map((entry) => entry.score)).toEqual([55, 80]);
  });
});
