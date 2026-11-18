# ReadySet for Jira

**Every ticket, sprint-ready.**

ReadySet scores each Jira issue's sprint-readiness from **0 to 100** with a
transparent, deterministic rubric — and shows the score plus exactly what's
missing right on the issue. A project dashboard ranks the whole project's
readiness and its worst offenders, one click drafts a proper description
with **Improve**, and the **ReadySet Coach** Rovo agent answers readiness
questions from the same scores.

Built on Atlassian Forge. No external backend, no API keys, and all data
stays in Forge storage on Atlassian.

- **Demo video:** [[DEMO VIDEO URL — paste the public YouTube link here]]
- **Installation link:** [[INSTALLATION LINK — paste the Forge installation link here]]

## Install

You need to be a **site admin** on the Jira Cloud site where you install
ReadySet.

1. Open the installation link above and follow the prompts to install
   ReadySet on your site.
2. Open any project. ReadySet adds:
   - a **ReadySet panel** on every issue (right-hand side of the issue view), and
   - a **ReadySet — Project Readiness** page in the project's navigation.
3. Open the project page once — the first open starts the initial scan of
   the project's open issues. Scores then stay fresh automatically:
   issue edits rescore through Jira's event triggers, and a nightly
   rescan re-checks every project.
4. *(Optional)* If your site has Rovo, **ReadySet Coach** appears as an
   agent once the app is installed. The rest of ReadySet works fully on
   any Jira site, with or without Rovo.

## Try it in 5 minutes

1. **See a score.** Open any issue and look at the ReadySet panel: the
   score, the grade (**Ready** 80+, **Almost** 60–79, **Not ready** below
   60), and a per-check list where every failure has a one-line fix.
2. **Improve a weak issue.** Pick an issue with a thin description, click
   **Improve**, review the drafted description (Goal / Context /
   Acceptance criteria / Notes) and its **projected score** — computed by
   the rubric, not promised by the model — then click **Apply**. The
   description is written in place, a comment records the change
   ("Description improved with ReadySet — readiness 20 → 60"), and the
   issue rescores. If the LLM is unavailable, a deterministic template
   draft is offered instead.
3. **Check the project.** Open the project page: average readiness,
   % Ready, grade counts, and the 25 lowest-scoring open issues. Click
   **Rescan now** to force a fresh pass.
4. **Tune it (project admins).** On the project page, set the Ready /
   Almost thresholds or switch off the estimate and due-date checks.
   Scores renormalize over the remaining checks, so the scale stays
   0–100.
5. **Ask the Coach (Rovo sites).** In Rovo chat, ask ReadySet Coach:
   *"How ready is ABC-123?"*, *"Which issues in my project are not ready
   yet?"*, or *"What should I fix first before sprint planning?"* The
   Coach answers only from stored scores — it never invents a number.

## The rubric

Ten checks, weights summing to 100. The same issue always gets the same
score, and every surface (panel, dashboard, rescan, Coach) uses this one
engine.

| Check | Weight | What it looks for |
|---|---|---|
| Description is substantial | 20 | Description text of at least 280 characters |
| Acceptance criteria present | 20 | A real acceptance-criteria section (heading + meaningful body), or a filled dedicated AC field |
| Estimate set | 10 | Story points or an original time estimate |
| Assignee set | 10 | Someone owns the work |
| Linked work or parent/epic | 10 | At least one issue link, a parent, or an epic link |
| No TBD / placeholder markers | 10 | No TBD, TBC, TODO, "to be decided", … in the text |
| Priority set | 5 | A priority is present |
| Labels or component set | 5 | At least one label or component |
| Summary is specific | 5 | A real, specific summary — not a vague placeholder |
| Due date set (high priority) | 5 | Required only for Highest/High priority; passes as not-applicable otherwise (a deliberate choice: low-priority work shouldn't lose points for lacking a deadline, and renormalizing would make scores incomparable across priorities) |

## Architecture

One pure TypeScript scoring library, four surfaces:

```
src/lib/rubric.ts        the scoring engine (pure, zero Forge imports)
src/lib/                 ADF <-> text, Jira adapter + per-site field map,
                         KVS store, aggregates, LLM prompt/parse boundary,
                         deterministic template fallback
src/functions/           resolver (panel, dashboard, settings, Improve,
                         Apply), event handler, scheduled rescan,
                         Rovo Coach actions
src/frontend/            UI Kit: issue panel, project page
static/agent/prompt.md   ReadySet Coach prompt
```

Design points worth noting:

- **Chunked, checkpointed scans.** Project scans page through Jira's
  token-paginated search one page per function invocation, checkpointing
  the page token and a seen-set in Forge KVS — a scan can pause and
  resume instead of hitting invocation time limits, and deleted or moved
  issues are reconciled only on scans that provably completed.
- **Per-site field map.** Story-point and epic-link field IDs are resolved
  per site from Jira's field list and folded into the panel's cache
  fingerprint, alongside the settings fingerprint and rubric version.
- **Constrained AI.** Improve drafts are cached by a hash of the issue's
  content; Apply refuses a stale draft; the projected score is the rubric
  run over the draft text. The Coach's three actions are read-only GETs
  over stored scores.
- **Permissions.** UI reads run *as the user*, so Jira's own issue-level
  security applies; project settings are gated on project-admin
  permission; triggers and the nightly rescan run as the app. Scopes:
  `read:jira-work`, `write:jira-work` (used only by Apply's description
  update and its audit comment), `storage:app`.

## Development

Requires Node 22. No Atlassian account is needed for the test suite —
handlers run against a fake Jira adapter and an in-memory store.

```bash
npm install
npm test            # vitest suite
npm run typecheck   # tsc --noEmit
npm run lint:manifest
```

**Tests: 142 passing across 11 files** — the rubric (fixture issues with
hand-computed scores: fully specified = exactly 100, empty = 15, messy =
20), handlers (including a 150-issue pagination run and checkpoint resume
across projects), the Improve flow (LLM draft, template fallback lifting
the messy fixture 20 → exactly 60, stale-draft refusal, Apply's write +
comment + rescore), the Coach actions, ADF handling, and a mocked-adapter
suite pinning the REST URLs and error mapping.

The codebase also went through a two-reviewer cross-review in which the
reviewers cross-critiqued each other's findings before fixes were
accepted: 39 findings, 31 fixed in code, each pinned by a regression
test.

## License

© 2026 Dilip Teneti. A `LICENSE` file will be added to this repository
before public release; until then, all rights reserved.
