# ReadySet for Jira

**Every ticket, sprint-ready.** ReadySet scores each Jira issue's
sprint-readiness (0–100) with a transparent, deterministic rubric —
description depth, acceptance criteria, estimate, priority, assignee,
labels/components, linked work, leftover TBD placeholders, summary
quality, and due dates on high-priority work — and shows the score plus
exactly what's missing right on the issue. A project page ranks the
whole project's readiness and its worst offenders.

Built on Atlassian Forge (UI Kit, KVS storage, product events, scheduled
rescan). All data stays on Atlassian; the scoring engine is a pure
TypeScript library shared by every surface.

## Layout

```
manifest.yml            Forge modules, functions, scopes
src/
  index.ts              Forge entry points (resolver + trigger handlers)
  lib/
    rubric.ts           the scoring engine (pure, no Forge imports)
    rubric-config.ts    weights, thresholds, vague-word & marker lists
    jira.ts             REST payload types, normalizer, adapter interface
    forge-jira.ts       production adapter (@forge/api requestJira)
    forge-store.ts      production KVS adapter (@forge/api storage)
    store.ts            score/settings persistence over a KV interface
    aggregate.ts        project statistics (pure)
    adf.ts              ADF <-> text helpers
  functions/
    resolver.ts         panel/dashboard/settings handlers (DI, tested)
    events.ts           issue created/updated -> rescore
    rescan.ts           nightly scheduled rescan
  frontend/
    issue-context.tsx   UI Kit issue panel
    project-page.tsx    UI Kit project dashboard + settings
static/agent/prompt.md  ReadySet Coach prompt (wired in phase 2)
test/                   vitest suite (rubric, adf, store, aggregate, handlers)
```

## Develop

```bash
npm install
npm test          # unit + handler tests (no Atlassian account needed)
npm run typecheck
```

Deployment, installation-link sharing, and judge setup instructions
arrive with phase 2 (Forge registration + dev site). See `../DESIGN.md`
for the full design and `../BUILD-LOG.md` for build status.
