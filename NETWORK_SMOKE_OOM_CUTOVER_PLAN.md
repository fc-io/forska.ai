# Network Smoke OOM Cutover Plan

Master coordinator: [DUCK_OOM_FIX_PLAN.md](./DUCK_OOM_FIX_PLAN.md)

Related plans:

- [DUCK_CQRS_PLAN_PHASE_5C.md](./DUCK_CQRS_PLAN_PHASE_5C.md)
- [docs/network-smoke-audit-plan.md](./docs/network-smoke-audit-plan.md)

## Objective

Use the browser network smoke audit as a Phase 5C regression gate for the DuckDB OOM cutover. The audit should prove normal browser routes still load after legacy maintenance retirement, while static guards, unit/integration tests, benchmarks, and Phase 6 physical evidence continue to prove SQL shape, workload admission, OOM recovery, and desktop behavior.

The execution order is real first, synthetic second:

1. Run the current/real database smoke audit first with `bun run test:network-smoke`.
2. Run the clean synthetic smoke audit second with `bun run test:network-smoke:synthetic`.

The real pass finds route failures against the current operator shape and existing data. The synthetic pass fills deterministic gaps when the current database lacks representative IDs or route state.

## Findings

| # | Finding | Required Outcome |
|---|---|---|
| 1 | Phase 5C and the master OOM gates do not list `bun run test:network-smoke`. | Add the real-first and synthetic-second smoke sequence to Phase 5C quality gates and the relevant master cross-phase gate. |
| 2 | The current real-data smoke path skips route loads known to write or queue work on load. | Phase 5C must retire, V4-rewire, or explicitly classify those side effects so skipped normal routes become audited routes before completion. |
| 3 | The smoke audit currently proves no unexpected browser/API errors, not OOM safety. | Treat it as a browser regression gate only. Keep SQL-shape guards, workload admission tests, V4 projector tests, benchmarks, and Phase 6 physical evidence as the OOM proof. |
| 4 | Current-DB route coverage depends on existing IDs and can skip dynamic routes with warnings. | Use the real pass first for operator realism, then use the synthetic pass for deterministic coverage of missing IDs and page states. |
| 5 | The smoke audit is browser-only. | Keep desktop build, owner-handoff, low-memory, restart, and sleep/process-kill evidence separate. |

## Phase 5C Integration

Phase 5C should use network smoke after warning, health, progress, admin, and review-route changes that affect browser-visible behavior. The smoke audit should not be the first line of defense for unsafe DuckDB work, but it should fail when browser routes crash, status APIs return 4xx/5xx, admin pages still expose broken legacy controls, or route error boundaries render.

Before Phase 5C is marked complete:

- The real/current-DB smoke pass runs first.
- The synthetic smoke pass runs second.
- Any route skipped because it can queue work on load is either audited, V4-rewired, or explicitly documented as admin/debug-only with a bounded read-only reason.
- The smoke report is recorded alongside static guard, focused test, lint, and desktop evidence.

## Smoke Scope

The smoke audit should cover these Phase 5C-visible surfaces:

- Review list routes for LLM, human, both, and unassessed modes.
- Review warning, progress, health, and freshness UI states.
- Admin investigation, DuckDB append, job health, and project-mart status pages that are safe to load.
- Project export, package export, article detail, and fulltext routes that depend on review-serving state.
- Route error boundaries, console errors, failed local app/API requests, and HTTP 4xx/5xx responses.

The smoke audit should not claim coverage for:

- Static SQL shape or forbidden-token guards.
- Workload admission and result-size budgets.
- V4 chunk split/park/quarantine behavior.
- Legacy runner symbol blocking.
- Phase 6 release-scale memory, temp-spill, row-group, RSS, latency, or desktop interruption proof.

## Workstreams

| Status | Theme | Done When |
|---|---|---|
| [ ] | Gate documentation | `DUCK_CQRS_PLAN_PHASE_5C.md` and `DUCK_OOM_FIX_PLAN.md` list the real-first, synthetic-second smoke sequence where relevant. |
| [ ] | Skipped-route resolution | Routes skipped because they write or queue work on load are audited after cutover, or retained only with explicit admin/debug classification. |
| [ ] | Evidence capture | Phase 5C release notes include commands run, failures fixed, skipped routes, and whether skips are data-missing or intentional admin/debug exclusions. |
| [ ] | Current-DB safety | The real/current-DB command remains no-seed and does not write synthetic fixture rows to the primary runtime database. |
| [ ] | Synthetic fallback | The synthetic pass creates deterministic fixture state only in its temporary DuckDB database. |

## Quality Gates

- [ ] `bun run test:network-smoke`
- [ ] `bun run test:network-smoke:synthetic`
- [ ] Any current-DB skipped route is classified as missing data, admin/debug-only, or unsafe pending Phase 5C rewiring.
- [ ] No skipped normal browser route remains solely because it queues legacy V3 repair, dirty refresh, or large-rebuild work on load.
- [ ] Focused Phase 5C tests still prove warning, health, and admin status routes are side-effect free.
- [ ] Static guards still prove legacy V3 rebuild/refresh SQL and symbols cannot run from normal paths.
- [ ] Desktop-specific checks remain separate: `bun run desktop:build` or targeted owner-handoff tests when shared runtime behavior changes.
