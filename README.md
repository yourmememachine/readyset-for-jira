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

- **Demo video:** https://youtu.be/DUy9v5RxW9A (2:50)
- **Installation link:** https://developer.atlassian.com/console/install/58468b0b-6f97-4b8b-adb7-8934eebea77c?signature=AYABeDOjyX7%2Fnf1iHBPkSJXf2wcAAAADAAdhd3Mta21zAEthcm46YXdzOmttczp1cy13ZXN0LTI6NzA5NTg3ODM1MjQzOmtleS83MDVlZDY3MC1mNTdjLTQxYjUtOWY5Yi1lM2YyZGNjMTQ2ZTcAuAECAQB4CxqLTo9l4lqXuFjNim1xJM%2Bp%2F3TVP9xHS2BrU5DRRucBn%2BeTrsmAXZ3lIcC2c6MfOgAAAH4wfAYJKoZIhvcNAQcGoG8wbQIBADBoBgkqhkiG9w0BBwEwHgYJYIZIAWUDBAEuMBEEDLNAlB9iBxexu3jTuAIBEIA7e152vtDLkHk8BOmEtW%2FatIMqbSYDVFK%2FMH58IrhR2LR%2FDBHnxWbeDfmOSeXew6JZbHI4IEIwvRuD5s8AB2F3cy1rbXMAS2Fybjphd3M6a21zOmV1LXdlc3QtMTo3MDk1ODc4MzUyNDM6a2V5LzQ2MzBjZTZiLTAwYzMtNGRlMi04NzdiLTYyN2UyMDYwZTVjYwC4AQICAHi9bVMAkme4qVQX1fQHo6ePw3H40A7cGfz7yrmSfBWMXgH%2BN4Xd4rjZJjYyvv4y584VAAAAfjB8BgkqhkiG9w0BBwagbzBtAgEAMGgGCSqGSIb3DQEHATAeBglghkgBZQMEAS4wEQQMEWswBzJIxmJQS73kAgEQgDvydEXa5KFPoQrgWRxhai79jEvyYV3uN8LkNzHqZpfk1iKfB6vi1tDSHenRwiquYGLJzXgQ2RmeL5avlQAHYXdzLWttcwBLYXJuOmF3czprbXM6dXMtZWFzdC0xOjcwOTU4NzgzNTI0MzprZXkvNmMxMjBiYTAtNGNkNS00OTg1LWI4MmUtNDBhMDQ5NTJjYzU3ALgBAgIAeDYASx0XCjkny4iLV6vz%2BKtEGSGT6kdt0QRpkn6D%2FlVEARjazB7XDQpK461CR%2BpO4J0AAAB%2BMHwGCSqGSIb3DQEHBqBvMG0CAQAwaAYJKoZIhvcNAQcBMB4GCWCGSAFlAwQBLjARBAw33ekAqL%2BN98NQ6t4CARCAO1RUJ8I1HVIpL14SccFIBWpwZ59R%2F6VmFw5Adgj0OlrzANaHvLfCIZar%2BKPfF%2B59f99pOPNyJLUgfEtxAgAAAAAMAAAQAAAAAAAAAAAAAAAAAK2tL3IzYVlTtBEP%2B2OO0gv%2F%2F%2F%2F%2FAAAAAQAAAAAAAAAAAAAAAQAAADJv%2FhxcROuo7qibEAY6eNWsaD3%2BR8XEAHcoQxtgTCKxGT%2FjGNy1mCLNJXNXmIrDqW4zrdZhg%2FLzuXdMLkd08VvrgEA%3D&product=jira

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
   **Improve description**, review the draft (Goal / Context /
   Acceptance criteria / Definition of done) with its per-section diff
   and **projected score** — computed by the rubric, not promised by
   the model — then click **Apply**. The description is written in
   place, a comment records the change and names the checks that
   flipped ("Description improved with ReadySet — readiness 20 → 60"),
   and the issue rescores. Tick **Also assign this issue to me** to
   take ownership in the same click. Two narrower tools sit beside it:
   **Acceptance criteria only** rewrites just that section and leaves
   the rest of the description untouched, and the summary tool suggests
   a specific summary when the current one is vague ("Fix bug"). If the
   LLM is unavailable, deterministic template drafts are offered
   instead. After applying, the panel's **Score history** line shows
   the move (e.g. "20 → 60").
3. **Check the project.** Open the project page: average readiness,
   % Ready, grade counts, a **Became Ready in the last 7 days** tile,
   and the 25 lowest-scoring open issues — filterable by type,
   assignee, and label. Admins also get **Improve 3 lowest
   (template)**, which applies template drafts to the three worst open
   issues in one click and reports each result. Click **Rescan now**
   to force a fresh pass.
4. **Tune it (project admins).** On the project page: the Ready /
   Almost thresholds, **every check toggleable with its own weight**
   (scores renormalize, so the scale stays 0–100), the section
   structure Improve drafts toward, **exclusions** (issue types or
   statuses ReadySet never scores), whether Done issues count on the
   dashboard, and opt-in usage counters.
5. **Search by score.** In Jira's issue search, try
   `project = ABC AND readysetScore < 60` (or the full-path form
   `issue.property['readyset'].score < 60`) to list everything below
   60. Scores are searchable because every rescore mirrors them into a
   Jira issue property.
6. **Create a Bug.** A bug with an empty description scores low and
   shows an extra check — **Steps to reproduce documented**. Add a
   "Steps to reproduce" section with Expected/Actual lines and watch
   it rescore.
7. **Ask the Coach (Rovo sites).** In Rovo chat, ask ReadySet Coach:
   *"How ready is ABC-123?"*, *"Which issues in my project are not
   ready yet?"*, *"What should I fix first before sprint planning?"*,
   *"What is the fastest win in my project?"*, or *"Why does ABC-123
   score higher than ABC-124?"* The Coach answers only from stored
   scores — it never invents a number.

## The rubric

Eleven checks. The ten general checks carry default weights summing to
100; bugs get an eleventh — steps to reproduce — and renormalize over
110. Every weight and every check's on/off state is configurable per
project (see step 4 above); the defaults are:

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
| Steps to reproduce documented | 10 | **Bug-type issues only** (Bug / Defect / Incident): a steps-to-reproduce section with a meaningful body, or an Expected/Actual pairing. Excluded from the denominator for every other issue type |

## How ReadySet works

Every time an issue is created or edited, ReadySet scores it against a
transparent rubric — description depth, acceptance criteria, estimate,
assignee, links, placeholders, and (for bugs) documented reproduction
steps. Each check shows the evidence it measured ("Description is only
12 characters — needs 280+") and a one-line fix, so a score is never a
black box. Scores are mirrored into a Jira issue property, which makes
them searchable from JQL, boards, and filters:

- `readysetScore < 60` — every issue below 60 (search-alias form)
- `issue.property['readyset'].score < 60` — the same via the full path

The stored record in the app's own storage is the source of truth; the
property is a searchable mirror that refreshes on every rescore. Two
honest caveats: the mirror is written by the app user, so it appears
only in projects where the app holds Edit issues permission (failures
are logged, never silent in `forge logs`), and an issue gains the
property at its first rescore after install — the nightly rescan
backfills the rest. Anyone who can edit an issue can also edit its
properties in Jira, which is exactly why the stored record — not the
property — is what the panel, dashboard, and Coach read.

The panel also keeps a short **score history** per issue and a
**Fix this next** callout naming the single highest-value failing
check with its true renormalized gain ("Fix this next: Description is
substantial (+20 pts → 40)").

**Improve** drafts a better description from the issue's own facts —
by AI on sites with Forge LLMs enabled, or by a deterministic template
otherwise — shows the projected score before anything is written, and
applies only when the user holds Edit issues permission in the project.
Applying posts an audit comment naming the checks that flipped.
Improve comes in three sizes: the full description rewrite, an
acceptance-criteria-only rewrite that merges just that section into
the existing description, and a summary suggestion for vague titles.
Applying can also assign the issue to the person who clicked Apply.

**Project admins shape the rubric**: thresholds, per-check weights
(scores renormalize, so the scale is always 0–100), any check toggled
off, and the section structure Improve drafts toward. The project page
tracks momentum — how many issues became Ready in the last 7 days —
and the worst-offenders table filters by type, assignee, and label.
Admins can also bulk-apply template improvements to the three
lowest-scoring open issues, exclude whole issue types or statuses
from scoring (their records and properties are removed), choose
whether Done issues count in the dashboard statistics, and opt in to
simple usage counters (scores computed, drafts generated, improvements
applied — stored in the site's own app storage only, off by default).

**Workflow validators (optional, company-managed projects).** Two
validators ship with the app — *ReadySet: Require Almost ready* and
*ReadySet: Require Ready*. A Jira admin attaches one to a workflow
transition in the workflow editor, and the transition then blocks
issues whose mirrored grade is below the bar; issues with no score
yet always pass. Honest limits: validators are a Forge **preview**
module, they attach in **company-managed** workflow editors
(team-managed projects use Jira's own rule set), and Jira fails a
transition **closed** if a validator expression errors — so test on a
scratch workflow before attaching one to a live transition.

On Rovo-enabled sites, the **ReadySet Coach** agent answers questions
("what should we fix first in this sprint?", "why does ABC-123 score
higher than ABC-124?") from the same stored scores via five read-only
actions.

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
  run over the draft text. The Coach's five actions are read-only GETs
  over stored scores.
- **Permissions.** UI reads run *as the user*, so Jira's own issue-level
  security applies; project settings are gated on project-admin
  permission; Apply is gated on the user's own Edit issues permission;
  triggers and the nightly rescan run as the app.

## Why each permission is requested

- `read:jira-work` — read issues to score them, list the site's fields
  to resolve the story-point / epic-link / acceptance-criteria fields,
  and check the current user's project permissions (admin for
  settings, Edit issues for Apply).
- `write:jira-work` — used only for the writes a user explicitly
  triggers from the panel or dashboard: an Apply's description update
  (full or acceptance-criteria-only), its audit comment, a summary
  update from the summary tool, an assignment when "assign to me" is
  ticked, and the `readyset` issue property that mirrors each score
  for JQL (written on rescore, deleted when an issue is excluded).
  Nothing else is ever written.
- `storage:app` — the app's own Forge storage holds the scores,
  settings, and draft cache for the installing site. Data never leaves
  Atlassian; see `PRIVACY.md`.

## Support

Questions, bug reports, and incorrect-score reports:
**tdilip2501@gmail.com** — answered within 2 business days. The issue
panel's "Report an incorrect score" link opens a prefilled email with
the issue key, score, and grade.

## Development

Requires Node 22. No Atlassian account is needed for the test suite —
handlers run against a fake Jira adapter and an in-memory store.

```bash
npm install
npm test            # vitest suite
npm run typecheck   # tsc --noEmit
npm run lint:manifest
```

**Tests: 272 passing across 14 files** — the rubric (fixture issues with
hand-computed scores: fully specified = exactly 100, empty = 15, messy =
20), handlers (including a 150-issue pagination run and checkpoint resume
across projects), the Improve flows (LLM draft, template fallback lifting
the messy fixture 20 → exactly 60, stale-draft refusal, Apply's write +
comment + rescore, acceptance-criteria-only merges, summary drafts,
Improve & Assign), the Coach actions, ADF handling, and a mocked-adapter
suite pinning the REST URLs and error mapping.

The codebase went through repeated two-reviewer cross-review rounds in
which the reviewers cross-critiqued each other's findings before fixes
were accepted — the first round alone raised 39 findings, 31 fixed in
code — and every fix is pinned by a regression test named after its
finding. The final feature set was then verified live on a real Jira
site, which caught three further defects (an assignment call that
needed a permission the app deliberately does not request, a summary
parser too strict for real model replies, and a fallback summary that
truncated mid-word); all three were fixed, re-tested, and re-verified
live.

## License

MIT — see the `LICENSE` file in this repository. © 2026 Dilip Teneti.
