import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../src/lib/rubric-config';
import { InMemoryKV, ScoreStore, normalizeImproveSections, normalizeSettings } from '../src/lib/store';
import type { ProjectSettings, StoredScore } from '../src/lib/types';

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
      checksEnabled: { ...DEFAULT_SETTINGS.checksEnabled, estimate: false, 'due-date': true, 'repro-steps': true },
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

  it('stamps lastBecameReadyAt on a transition into Ready, never on first sight (A7)', async () => {
    const kv = new InMemoryKV();
    const store = new ScoreStore(kv);
    await store.saveScore({ ...record('RS-1', 'RS', 95) });
    expect((await store.getScore('RS-1'))?.lastBecameReadyAt).toBeUndefined();
    await store.saveScore({ ...record('RS-2', 'RS', 20), grade: 'not-ready' });
    await store.saveScore({ ...record('RS-2', 'RS', 90), grade: 'ready' });
    expect((await store.getScore('RS-2'))?.lastBecameReadyAt).toBe('2026-11-17T10:05:00.000Z');
  });

  it('the became-Ready stamp survives the 10-entry history cap (A7)', async () => {
    const kv = new InMemoryKV();
    const store = new ScoreStore(kv);
    await store.saveScore({ ...record('RS-1', 'RS', 10), grade: 'not-ready' });
    await store.saveScore({ ...record('RS-1', 'RS', 90), grade: 'ready' });
    for (let score = 91; score <= 100; score += 1) {
      await store.saveScore({ ...record('RS-1', 'RS', score), grade: 'ready' });
    }
    const saved = await store.getScore('RS-1');
    expect(saved?.history?.some((entry) => entry.grade !== 'ready')).toBe(false);
    expect(saved?.lastBecameReadyAt).toBe('2026-11-17T10:05:00.000Z');
  });
});

describe('normalizeSettings weights (Wave 2)', () => {
  it('merges partial weights over the base and clamps them', () => {
    const merged = normalizeSettings(
      { weights: { estimate: 250, priority: -3 } } as unknown as Partial<ProjectSettings>,
      DEFAULT_SETTINGS,
    );
    expect(merged.weights.estimate).toBe(100);
    expect(merged.weights.priority).toBe(0);
    expect(merged.weights.description).toBe(20);
  });

  it('an all-zero enabled weight map falls back to the base weights', () => {
    const zeroed = Object.fromEntries(
      Object.keys(DEFAULT_SETTINGS.weights).map((id) => [id, 0]),
    ) as ProjectSettings['weights'];
    const merged = normalizeSettings({ weights: zeroed }, DEFAULT_SETTINGS);
    expect(merged.weights).toEqual(DEFAULT_SETTINGS.weights);
  });

  it('legacy settings without weights or new toggles normalize to defaults', () => {
    const legacy = {
      readyThreshold: 80,
      almostThreshold: 60,
      checksEnabled: { estimate: true, 'due-date': true, 'repro-steps': true },
    } as unknown as Partial<ProjectSettings>;
    const merged = normalizeSettings(legacy, DEFAULT_SETTINGS);
    expect(merged.weights).toEqual(DEFAULT_SETTINGS.weights);
    expect(merged.checksEnabled.description).toBe(true);
  });

  it('an all-disabled check map falls back to the base toggles (A2)', () => {
    const allOff = Object.fromEntries(
      Object.keys(DEFAULT_SETTINGS.checksEnabled).map((id) => [id, false]),
    ) as ProjectSettings['checksEnabled'];
    const merged = normalizeSettings({ checksEnabled: allOff }, DEFAULT_SETTINGS);
    expect(merged.checksEnabled).toEqual(DEFAULT_SETTINGS.checksEnabled);
  });
});

describe('normalizeImproveSections (Wave 2 cross-review)', () => {
  it('drops a heading that merely contains the AC phrase and inserts the canonical one (A3)', () => {
    const merged = normalizeImproveSections(
      ['Goal', 'Team acceptance criteria', 'Notes'],
      DEFAULT_SETTINGS.improveSections,
    );
    expect(merged).toEqual(['Goal', 'Acceptance criteria', 'Notes']);
  });

  it('collapses duplicate AC headings to the first (A4)', () => {
    const merged = normalizeImproveSections(
      ['Goal', 'Acceptance criteria', 'Acceptance criteria (extended)', 'Notes'],
      DEFAULT_SETTINGS.improveSections,
    );
    expect(merged.filter((name) => /^acceptance criteria/i.test(name))).toHaveLength(1);
  });

  it('never returns more than six sections, even after inserting the AC heading (A4)', () => {
    const merged = normalizeImproveSections(
      ['Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon', 'Zeta'],
      DEFAULT_SETTINGS.improveSections,
    );
    expect(merged).toHaveLength(6);
    expect(merged.some((name) => /^acceptance criteria\b/i.test(name))).toBe(true);
  });

  it('keeps an anchored AC variant the admin chose', () => {
    const merged = normalizeImproveSections(
      ['Goal', 'Acceptance criteria (done when)', 'Notes'],
      DEFAULT_SETTINGS.improveSections,
    );
    expect(merged).toEqual(['Goal', 'Acceptance criteria (done when)', 'Notes']);
  });
});

describe('normalizeSettings Wave 3 fields', () => {
  it('defaults exclusions to empty, Done policy to exclude, analytics to off', () => {
    const merged = normalizeSettings({}, DEFAULT_SETTINGS);
    expect(merged.excludedIssueTypes).toEqual([]);
    expect(merged.excludedStatuses).toEqual([]);
    expect(merged.donePolicy).toBe('exclude');
    expect(merged.analyticsEnabled).toBe(false);
  });

  it('normalizes exclusion lists: trims, dedupes case-insensitively, drops junk', () => {
    const merged = normalizeSettings(
      {
        excludedIssueTypes: [' Bug ', 'bug', '', 'x'.repeat(41), 'Task'],
        excludedStatuses: ['Done'],
        donePolicy: 'include',
        analyticsEnabled: true,
      },
      DEFAULT_SETTINGS,
    );
    expect(merged.excludedIssueTypes).toEqual(['Bug', 'Task']);
    expect(merged.excludedStatuses).toEqual(['Done']);
    expect(merged.donePolicy).toBe('include');
    expect(merged.analyticsEnabled).toBe(true);
  });

  it('an unknown Done policy value falls back to exclude', () => {
    const merged = normalizeSettings(
      { donePolicy: 'sometimes' as never },
      DEFAULT_SETTINGS,
    );
    expect(merged.donePolicy).toBe('exclude');
  });
});
