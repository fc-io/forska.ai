# Workstream 1 Implementation Plan

This is the active change plan for `OS_IT_PLAN.md` Workstream 1: public docs and Docker/publication artifacts.

## Scope

- Docs currently tracked in this repo, local-run docs, setup docs, architecture notes, and docs they reference.
- Docker/publication artifacts: `Dockerfile*`, compose files, CI/workflow config, release helpers, and remote-run docs.
- Every doc and artifact gets one final action: keep as-is, rewrite, remove, or move to another repo/folder such as `../hpc-manager` or `../docs/future`.
- Out of scope: route/API decisions, history cleanup, licensing decisions, and go/no-go release approval.

## Steps

- [x] Inventory tracked docs and referenced docs.
- [x] Mark each doc as keep as-is, rewrite, remove, or move to another repo/folder.
- [x] Scan docs marked keep as-is or rewrite for private hostnames, credentials, datasets, stack roots, backup paths, local machine paths, and remote-run assumptions.
- [x] Rewrite kept docs with placeholders, public paths, and loopback/local defaults.
- [ ] Inventory Docker/publication artifacts: `Dockerfile*`, compose files, CI/workflow config, release helpers, and remote-run docs.
- [ ] Mark each artifact as keep as-is, rewrite, remove, or move to another repo.
- [ ] Rewrite kept Docker/compose artifacts so defaults are local-safe and free of private registries, private runners, SSH aliases, stack roots, remote hosts, and broad bind assumptions.
- [ ] Move real non-Forska workflows to their owning repo, for example remote/HPC helpers to `../hpc-manager`, instead of leaving them half-documented here.
- [x] Update public docs so they advertise only supported local workflows, kept artifacts, and intentionally moved public workflows.
- [ ] Record unresolved scope, API, route, secret, or licensing questions as blockers for Workstream 11.
- [x] Produce a concise decision table for docs and Docker/publication artifacts with file, action, target repo/path, reason, and blocker if any.

## Current Decisions

These decisions record intended public-release handling. This workstream does not require deleting plan files during the cleanup itself.

| File or Group | Action | Target Repo/Path | Reason | Blocker |
| --- | --- | --- | --- | --- |
| `LICENSE` | Keep as-is | Forska | Apache 2.0 license is already public project material. | None |
| `SECURITY.md` | Add done | Forska | Public security policy now documents private reporting expectations and local-first security posture. | None |
| `CONTRIBUTING.md` | Add done | Forska | Public contributor guide now documents setup, checks, and public-safe development notes. | None |
| `README.md` | Rewrite done | Forska | Public entrypoint now describes the supported local-first web workflow and provider setup. | None |
| `docs/README_RUN_LOCAL.md` | Rewrite done | Forska | Local run doc avoids private helper repos, internal runtime drills, and admin/debug routes. | None |
| `docs/README_SPLIT_RUNTIME_VERIFICATION.md` | Remove done | N/A | Internal runtime verification doc described owner RPC, admin diagnostics, and failover drills. | None |
| `AGENTS.md` | Hold for now | Forska cleanup branch | User requested no action for now. Final contributor-doc handling can happen later. | Contributor-docs decision |
| `OS_IT_PLAN.md` and `plans/openSource*.md` | Keep during cleanup | Forska cleanup branch | Active release planning docs. Keep for now; decide final handling in Workstream 11. | Final release-scope decision |
| Root `*_PLAN.md` files and `plans/old/*` | Keep during cleanup | Forska cleanup branch | Internal implementation history and planning material. Keep for now; decide final handling in Workstream 11. | Final release-scope decision |
| `future/**/*.md` | Move done | `../docs/future/` | Example/reference material was moved out of the Forska repo for separate review. | Licensing/data-rights review before public use |
| `scripts/createUnexpectedAnswersAdminPage.md` | Remove done | N/A | Stale admin-page note, not public project documentation as-is. | None |
| `Dockerfile*`, compose files, `.github/workflows/*` | No current files | N/A | No Docker, compose, or GitHub workflow artifacts currently exist in this repo. | None |
| `scripts/monitorSyncProgress.sh` | Hold for pass 2 | Forska cleanup branch | Publication artifact/script handling is paused. Likely obsolete Postgres/ClickHouse Docker sync monitor. | Script inventory review |
| `scripts/dbRepairJudgmentsIndex.sh` | Hold for pass 2 | Forska cleanup branch | Publication artifact/script handling is paused. Likely legacy Postgres repair helper tied to remote/tunneled DB workflow. | Script inventory review |
| `scripts/dbBackup.ts` | Hold for pass 2 | Forska cleanup branch | Publication artifact/script handling is paused. Potentially useful local DuckDB backup helper. | Script inventory review |
| Maintenance/rebuild scripts under `scripts/` | Hold for pass 2 | Forska cleanup branch | Publication artifact/script handling is paused. Do not advertise in public quickstart docs until route/runtime decisions settle. | Route/runtime decisions |

## Quality Gates

- [ ] Manual verify: every doc kept in this repo is free of private hostnames, credentials, datasets, stack roots, backup paths, local machine paths, and unsupported remote-run assumptions.
- [ ] Manual verify: every kept Docker/compose artifact has local-safe defaults and no private registry, private runner, SSH alias, stack root, remote host, or broad bind assumption.
- [ ] Manual verify: public docs reference only commands and artifacts that are kept here or intentionally moved outside this repo.
- [ ] Run `bun run build` if Docker, package scripts, runtime paths, app config, or public run commands change.
- [ ] Skip code tests unless route, server, client, or runtime code changes are made.
