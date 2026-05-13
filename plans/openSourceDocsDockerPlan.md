# Workstream 1 Implementation Plan

This is the active change plan for `OS_IT_PLAN.md` Workstream 1: public docs and Docker/publication artifacts.

## Scope

- Docs currently tracked in this repo, local-run docs, setup docs, architecture notes, and docs they reference.
- Docker/publication artifacts: `Dockerfile*`, compose files, CI/workflow config, release helpers, and remote-run docs.
- Every doc and artifact gets one final action: keep as-is, rewrite, remove, or move to another repo such as `../hpc-manager`.
- Out of scope: route/API decisions, history cleanup, licensing decisions, and go/no-go release approval.

## Steps

- [ ] Inventory tracked docs and referenced docs.
- [ ] Mark each doc as keep as-is, rewrite, remove, or move to another repo.
- [ ] Scan docs marked keep as-is or rewrite for private hostnames, credentials, datasets, stack roots, backup paths, local machine paths, and remote-run assumptions.
- [ ] Rewrite kept docs with placeholders, public paths, and loopback/local defaults.
- [ ] Inventory Docker/publication artifacts: `Dockerfile*`, compose files, CI/workflow config, release helpers, and remote-run docs.
- [ ] Mark each artifact as keep as-is, rewrite, remove, or move to another repo.
- [ ] Rewrite kept Docker/compose artifacts so defaults are local-safe and free of private registries, private runners, SSH aliases, stack roots, remote hosts, and broad bind assumptions.
- [ ] Move real non-Forska workflows to their owning repo, for example remote/HPC helpers to `../hpc-manager`, instead of leaving them half-documented here.
- [ ] Update public docs so they advertise only supported local workflows, kept artifacts, and intentionally moved public workflows.
- [ ] Record unresolved scope, API, route, secret, or licensing questions as blockers for Workstream 11.
- [ ] Produce a concise decision table for docs and Docker/publication artifacts with file, action, target repo/path, reason, and blocker if any.

## Quality Gates

- [ ] Manual verify: every doc kept in this repo is free of private hostnames, credentials, datasets, stack roots, backup paths, local machine paths, and unsupported remote-run assumptions.
- [ ] Manual verify: every kept Docker/compose artifact has local-safe defaults and no private registry, private runner, SSH alias, stack root, remote host, or broad bind assumption.
- [ ] Manual verify: public docs reference only commands and artifacts that are kept here or intentionally moved to another public repo.
- [ ] Run `bun run build` if Docker, package scripts, runtime paths, app config, or public run commands change.
- [ ] Skip code tests unless route, server, client, or runtime code changes are made.
