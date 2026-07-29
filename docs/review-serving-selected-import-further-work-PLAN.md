# Review-Serving Selected-Import Further Work PLAN

## Context

Selected-import ownership is at the planned boundary after PR #337. Runtime
writes flow through selected-import staging/publish into
`mart.review_selected_article_import_current_v4`, runtime readers and evidence
use the mart owner, and `app.review_selected_article_import_v4` remains only as
a temporary compatibility view.

Do not keep pushing runtime ownership churn unless a new concrete leak is found.
The next work should be one of these separate tracks:

1. Retire the compatibility view and schema-history remnants.
2. Improve selected-import evidence-query performance and operator ergonomics.

## Track 1: Compatibility View Retirement

Goal: remove the temporary `app.review_selected_article_import_v4`
compatibility surface once older tooling and schema expectations no longer need
that name.

Recommended approach:

- Audit all remaining references to `app.review_selected_article_import_v4`.
- Classify each remaining reference as historical migration, docs, explicit
  compatibility constant, test guard, or live runtime/tooling dependency.
- Keep historical migrations intact unless a migration is actively wrong for
  new databases.
- Remove or replace live tooling dependencies first, then retire the explicit
  compatibility constant and absence guard in one coherent cleanup slice.
- Add a migration that removes the compatibility view only when new-database
  creation, startup probes, and current-DB migration all pass without it.

Acceptance criteria:

- No non-test runtime or script depends on
  `app.review_selected_article_import_v4`.
- Schema tests prove new databases build without the compatibility view.
- Startup/current-DB migration proves existing databases can move forward.
- Current/staging selected-import evidence remains clean:
  duplicate current keys `0`, unpublished staging rows `0`, duplicate staging
  identities `0`.
- `TESTS.md` reflects the new guard shape after compatibility removal.

Required gates:

- Focused schema, startup, selected-import projector, writer, retention, and
  phase-3 integration tests.
- `bun run bench:review-serving-release-gate`.
- `bun run test:dev-server:current-db`.
- `bun run test:network-smoke:current-db:readonly`.
- Current-DB physical evidence script.

## Track 2: Evidence Query Performance

Goal: make selected-import physical evidence cheaper and easier to interpret
without weakening the ownership checks.

Recommended approach:

- Profile `scripts/inspectReviewServingPhysicalEvidence.ts` against current DB.
- Identify whether selected-import current/staging sections do broad scans that
  can be bounded by project, source partition, snapshot/generation, or sampled
  duplicate probes.
- Keep the default report complete enough for release gates.
- Add optional narrow flags only if they reduce operator cost without hiding
  release-gate evidence.
- Preserve the current ownership semantics: evidence should name
  `mart.review_selected_article_import_current_v4` and
  `mart.review_selected_article_import_staging_v4` as the selected-import
  surfaces, not the compatibility view.

Acceptance criteria:

- Physical evidence output still reports current and staging selected-import
  duplicate checks.
- Any narrowed mode clearly states what was scoped and what was not checked.
- Operator tests cover the selected-import evidence shape.
- Current-DB release evidence remains actionable and not compatibility-view
  centered.

Required gates:

- `bun test scripts/operatorScriptDuckdbAccess.test.ts`.
- Targeted `bunx eslint` for touched files.
- `git diff --check`.
- Current-DB physical evidence script.
- `bun run bench:review-serving-release-gate` if release-gate output changes.

## New Session Prompt

Use this prompt to start a fresh session for the follow-up work:

```text
We are in `/Users/fredrik/Developer/forska.ai`. Continue the selected-import
post-PR #337 follow-up from
`docs/review-serving-selected-import-further-work-PLAN.md`.

Important context:
- PR #337 left selected-import at the planned ownership boundary.
- Runtime ownership should not be churned unless you find a new concrete leak.
- `mart.review_selected_article_import_current_v4` is the selected-import
  current owner.
- `mart.review_selected_article_import_staging_v4` is the staging/replay owner.
- `app.review_selected_article_import_v4` is only a temporary compatibility
  view.
- Prior live evidence was green: release gate, current-DB dev-server smoke,
  readonly network smoke, duplicate mart keys 0, compatibility mismatches 0,
  unpublished staging rows 0.

Please orchestrate with Codex workers for the investigation-heavy parts. Keep
the main session as reviewer/integrator.

Start by checking repo state and reading:
- `docs/review-serving-selected-import-further-work-PLAN.md`
- `docs/review-serving-selected-import-full-ownership-plan.md`
- `TESTS.md`
- `src/server/reviewServing/reviewServingPhase3Integration.test.ts`
- `scripts/inspectReviewServingPhysicalEvidence.ts`

Then choose exactly one coherent next slice:
1. Compatibility view retirement/schema-history cleanup, if there are no live
   dependencies left and current-DB migration can prove it; or
2. Evidence-query performance/operator ergonomics, if compatibility retirement
   is not yet ready.

Do not remove historical migrations just to reduce grep output. Do not weaken
the selected-import current/staging ownership guards. Do not introduce a
parallel old/new runtime path. Before opening a PR, run the focused tests named
in this PLAN plus the live current-DB gates required by the Forska progress
gate. Include current-DB duplicate/staging evidence in the PR summary.
```
