# Workstream 1 Implementation Plan

This is the active change plan for `OS_IT_PLAN.md` Workstream 1: sanitized public docs and Docker/publication artifacts.

## Scope

- Public docs, local-run docs, setup docs, architecture notes, and docs they reference.
- Docker/publication artifacts: `Dockerfile*`, compose files, CI/workflow config, release helpers, and remote-run docs.
- Out of scope: final public repo allowlist, route/API decisions, history cleanup, licensing decisions, and go/no-go release approval.

## Steps

- [ ] Inventory candidate public docs and referenced docs.
- [ ] Mark each candidate doc as public, sanitize, private, or remove from first public seed.
- [ ] Scan candidate docs for private hostnames, credentials, datasets, stack roots, backup paths, local machine paths, and remote-run assumptions.
- [ ] Sanitize docs kept for public release with placeholders, public paths, and loopback/local defaults.
- [ ] Inventory Docker/publication artifacts: `Dockerfile*`, compose files, CI/workflow config, release helpers, and remote-run docs.
- [ ] Mark each artifact as keep, sanitize, private, or remove from first public seed.
- [ ] Sanitize kept Docker/compose artifacts so defaults are local-safe and free of private registries, private runners, SSH aliases, stack roots, remote hosts, and broad bind assumptions.
- [ ] Update public docs so they advertise only supported local workflows and kept artifacts.
- [ ] Record unresolved scope, API, route, secret, or licensing questions as blockers for Workstream 11.
- [ ] Produce a concise kept/private/removed decision table for docs and Docker/publication artifacts.

## Quality Gates

- [ ] Manual verify: every public doc is free of private hostnames, credentials, datasets, stack roots, backup paths, local machine paths, and unsupported remote-run assumptions.
- [ ] Manual verify: every kept Docker/compose artifact has local-safe defaults and no private registry, private runner, SSH alias, stack root, remote host, or broad bind assumption.
- [ ] Manual verify: public docs reference only commands and artifacts that remain in the public seed.
- [ ] Run `bun run build` if Docker, package scripts, runtime paths, app config, or public run commands change.
- [ ] Skip code tests unless route, server, client, or runtime code changes are made.
