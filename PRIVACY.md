# Privacy Policy — ReadySet for Jira

_Last updated: November 17, 2026_

ReadySet for Jira is a Forge app built and maintained by Dilip Teneti
("the developer"). This policy describes what the app stores, where,
and what the developer can and cannot see.

## What the app does

ReadySet scores Jira issues for sprint readiness, shows the scores in
an issue panel and a project dashboard, can draft improved issue
descriptions (using Atlassian's Forge LLMs, or a built-in template
when the LLM is unavailable), and offers a Rovo agent ("ReadySet
Coach") that answers questions from the stored scores on
Rovo-enabled sites.

## What the app stores, and where

All app data is stored in **Forge Key-Value Storage on the Jira site
where the app is installed**. Nothing is stored on the developer's
systems, and the developer has **no access** to any installed site's
stored data.

Per scored issue, the app stores:

- the issue key, project key, summary, and status;
- the computed readiness score and its per-check results. Check
  details are short explanations and can include a Jira user's
  **display name** (for example, "Assigned to Jane Doe.") — this is
  the only personal data the app stores;
- timestamps and internal fingerprints used to keep scores fresh.

When a user runs the Improve flow, the app additionally caches the
generated draft (derived from the issue's own summary and
description) in the same storage, keyed by a hash of the issue
content, until it is applied or superseded.

Project administrators' readiness settings (thresholds and which
checks are enabled) are stored per project in the same storage.

## What the app does not do

- It does not send data to the developer or to any third party.
  The only external processing is Atlassian's own Forge LLMs API
  when a user explicitly clicks "Improve description"; the issue's
  summary, description, and failing-check hints are sent to that
  Atlassian-hosted API to produce the draft, under Atlassian's
  platform terms.
- It does not track users, run analytics, or store credentials.
- It never writes to Jira except when a user clicks **Apply** on an
  Improve draft (replacing that issue's description) and posting a
  comment on that issue recording the score change.

## Data retention and removal

Stored scores are refreshed automatically as issues change, and
scores for deleted issues are removed. Uninstalling the app removes
its access; stored data is deleted by the Forge platform in
accordance with Atlassian's app-data policies.

## Contact

Questions about this policy: tdilip2501@gmail.com
