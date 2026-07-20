# Workstream 1 Implementation Plan

This is the active change plan for `plans/old/OS_IT_PLAN.md` Workstream 1: public docs and Docker/publication artifacts.

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
- [x] Inventory Docker/publication artifacts: `Dockerfile*`, compose files, CI/workflow config, release helpers, and remote-run docs.
- [x] Mark each artifact as keep as-is, rewrite, remove, or move to another repo.
- [x] Rewrite kept Docker/compose artifacts so defaults are local-safe and free of private registries, private runners, SSH aliases, stack roots, remote hosts, and broad bind assumptions.
- [x] Move or remove real non-Forska workflows instead of leaving them half-documented here.
- [x] Update public docs so they advertise only supported local workflows, kept artifacts, and intentionally moved public workflows.
- [x] Record unresolved scope, API, route, secret, or licensing questions as blockers for Workstream 11.
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
| `plans/old/OS_IT_PLAN.md` and `plans/openSource*.md` | Keep during cleanup | Forska cleanup branch | Active release planning docs. Keep for now; decide final handling in Workstream 11. | Final release-scope decision |
| Root `*_PLAN.md` files and `plans/old/*` | Keep during cleanup | Forska cleanup branch | Internal implementation history and planning material. Keep for now; decide final handling in Workstream 11. | Final release-scope decision |
| `future/**/*.md` | Move done | `../docs/future/` | Example/reference material was moved out of the Forska repo for separate review. | Licensing/data-rights review before public use |
| `scripts/createUnexpectedAnswersAdminPage.md` | Remove done | N/A | Stale admin-page note, not public project documentation as-is. | None |
| `Dockerfile*`, compose files, `.github/workflows/*` | No current files | N/A | No Docker, compose, or GitHub workflow artifacts currently exist in this repo. Do not add Docker until there is a real local-safe public workflow. | None |
| `scripts/monitorSyncProgress.sh` | Remove done | N/A | Obsolete Postgres/ClickHouse Docker sync monitor with hardcoded old-stack assumptions. | None |
| `scripts/dbRepairJudgmentsIndex.sh` | Remove done | N/A | Legacy Postgres repair helper tied to a remote/tunneled DB workflow. | None |
| Core local scripts used by public commands | Address later | Forska | `runWithRuntimeProfile.ts`, `startServerStack.ts`, `devServerWatch.ts`, and `runBunTests.ts` back the supported local workflow. Final script classification can happen with the broader script review. | Script inventory review |
| Local DuckDB helper scripts | Keep | Forska | `dbBackup.ts`, `dbStudio.ts`, and `dbQuerySnapshot.ts` are local DuckDB tools. Keep them out of public quickstart docs unless support expectations are decided. | Optional docs/support decision |
| Maintenance/rebuild scripts under `scripts/` | Keep | Forska | Current local developer/operator tools should remain for now, but should not be advertised in public quickstart docs until route/runtime decisions settle. | Route/runtime decisions |

## Quality Gates

- [x] Manual verify: every doc kept in this repo is free of private hostnames, credentials, datasets, stack roots, backup paths, local machine paths, and unsupported remote-run assumptions.
- [x] Manual verify: every kept Docker/compose artifact has local-safe defaults and no private registry, private runner, SSH alias, stack root, remote host, or broad bind assumption. No Docker/compose artifacts are currently kept.
- [x] Manual verify: public docs reference only commands and artifacts that are kept here or intentionally moved outside this repo.
- [x] Skip `bun run build` because no Docker, package script, runtime path, app config, or public run command changed.
- [x] Skip code tests because no route, server, client, or runtime code changes were made.
