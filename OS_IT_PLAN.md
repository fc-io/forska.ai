# Open Source Investigation Plan

## Core Release Principle

- Default to a fail-closed release: if a route, script, doc, asset, or historical secret is not clearly safe for public distribution, treat it as blocked until reviewed.
- The public Forska repo should contain only public project material. For each current doc, script, artifact, or file group, choose one action before publishing: keep as-is, rewrite, remove, or move to another repo.
- Do not confuse local integration with public internet exposure. The intended open-source shape includes a documented API for local apps on the same machine, while unsupported internal/debug/operator routes stay clearly separated.
- Assume exhaustive discovery of every old API use in git history is not realistic. The default public-release path should therefore avoid publishing the existing private history.

## Preferred Public Release Path

1. Keep the current repo private.
   - Do not expose existing branches, tags, or commit history.
   - Treat the private repo as the internal source of truth and audit workspace.
2. Create a new public repo from a clean audited snapshot.
   - Export from one reviewed commit only, or from an orphan clean-history branch.
   - Publish only after the snapshot has passed the route, secret, docs, and infra review.
3. Resolve the current repo contents into public-repo actions.
   - Keep files as-is when they are safe, useful, and belong in the Forska repo.
   - Rewrite files that belong in Forska but currently contain private, obsolete, or unsupported assumptions.
   - Remove files that are generated, obsolete, sensitive, or have no public project value.
   - Move files that are real workflows for another project, such as remote/HPC helpers that belong in `../hpc-manager`.

## Public Repo File Decision Rules

- Keep the normal public OSS flow working from tracked docs: `bun install`, `bun run db:mig`, `bun run dev:server`, `bun run dev:app`, `bun run build`, and relevant `bun test` commands.
- Keep reviewed product code under `src/`, but only after the route and surface audit removes or gates internal-only endpoints.
- Keep a supported local API contract based on `plans/supportedLocalApi.md`, so local LLM apps, agents, scripts, browser UI, and desktop app know which routes are stable. Implement that contract last, after route cleanup and sensitive-route decisions are complete.
- Keep DuckDB migration files under `src/db/duckdbMigrations/` and any other schema/runtime files required for first boot.
- Keep tests that validate the public product surface, as long as fixtures and snapshots are safe to publish.
- Keep root build and tooling files needed for public development, such as `package.json`, `bun.lock`, `tsconfig.json`, `vite.config.ts`, `eslint.config.ts`, `playwright.config.ts`, `.gitignore`, `.prettierrc.js`, `.prettierignore`, and `index.html`.
- Keep, rewrite, remove, or move each `scripts/` file. Normal local OSS setup, migration, build, test, and packaging scripts stay here; remote ops scripts move to their owning repo or are removed.
- Rewrite public docs that belong in Forska: `README.md`, local-run docs, architecture notes, `SECURITY.md`, and `CONTRIBUTING.md`.
- Keep `Dockerfile` or compose files only if they support a real public workflow, bind safely by default, and contain no private infra assumptions. Move real remote/HPC Docker workflows to their owning repo, for example `../hpc-manager`.
- Remove all old git history, private branches, and private tags from the published repo by publishing from a clean snapshot or clean-history branch.
- Remove runtime and generated material: `.env*`, `data/`, `cache/`, `dist/`, `desktopBuild/`, `node_modules/`, `test-results/`, `tmp/`, logs, and local machine artifacts.
- Remove structured runtime telemetry such as `logs/runtime/` JSONL files and desktop `backend.log`; confirm those paths stay gitignored and never enter the published repo.
- Remove or move private infra and ops material: remote backup helpers, cluster launch helpers, and any script tied to SSH aliases, stack roots, or private environments.
- Remove or move non-Forska publication artifacts: `Dockerfile.sglang`, `Dockerfile.sglang-gateway`, remote-only compose overrides, remote-run docs, CI or release config with private runners or registries, and any release helper that assumes private infrastructure.
- Resolve ambiguous or internal planning material one file at a time: keep as-is if useful and safe for public contributors, rewrite into public docs if needed, remove if obsolete, or move to another repo if it belongs outside Forska.
- Remove all datasets, imported assets, cached PDFs, snapshots, and example files unless they are explicitly reviewed, licensed for redistribution, and scrubbed of sensitive content.
- Any unclear file is a release blocker until it has one of the four actions: keep as-is, rewrite, remove, or move.

## Workstreams

### 1. Prepare public docs and Docker/publication artifacts

- Active implementation plan: [`plans/openSourceDocsDockerPlan.md`](plans/openSourceDocsDockerPlan.md).
- Inventory tracked docs: `README.md`, local-run docs, architecture notes, setup docs, and any docs referenced by those files.
- Mark each doc as keep as-is, rewrite, remove, or move to another repo.
- Rewrite kept public docs so examples use placeholders, public paths, loopback/local defaults, and no private hostnames, credentials, datasets, stack roots, backup paths, or remote-run assumptions.
- Inventory Docker and publication artifacts separately: `Dockerfile*`, compose files, CI/workflow config, release helpers, and remote-run docs.
- For each Docker or compose artifact, mark keep as-is, rewrite, remove, or move to another repo, and require safe local defaults with no private registry, private runner, SSH alias, stack root, remote host, or broad bind assumption for anything kept here.
- Keep Docker or compose files in Forska only if they support a real public Forska workflow; otherwise remove them or move them to their owning repo.
- Record unresolved scope questions as blockers for the final public release-scope workstream, not as assumptions in public docs or Docker files.

### 2. Inventory the current server and API surface

- Use `plans/supportedLocalApi.md` as the companion decision framework for deciding which localhost routes are stable local integration APIs versus internal/debug implementation details. Do not implement the manifest/docs/regression checks from that plan until late-stage cleanup.
- Build a network surface inventory from `src/server/index.ts`, `src/server/serverMain.ts`, `src/appServer.ts`, `src/appServerMain.ts`, every file under `src/server/routes/`, and any nested or transitively mounted routes.
- For each listener, proxy entrypoint, or route, record: bind host, path, methods, mounted role, proxy behavior, client caller, local integration caller, data touched, whether it is required for the product, and whether it should keep shipping, be rewritten/gated, removed, or moved out of this repo.
- Classify each route into one of: supported local API, local diagnostics API, sensitive local API, internal runtime API, maintenance/debug API, or remove before release.
- Pay special attention to current hotspots: `AdminInvestigateRoutes`, `ArticleAdminRoutes`, `DuckdbStudioRoutes`, `NvidiaSmiRoutes`, `LlmStatusRoutes`, `ApiProxyRoutes`, `TokensRoutes`, `UsersRoutes`, `RuntimeAssetsRoutes`, the provider routes mounted under `ModelsRoutes`, and the `/api/*` proxy path in `src/appServer.ts`.
- Compare the route inventory against the README claim that the app is single-user with no admin role, while preserving the intended local integration API for same-machine tools. Any mismatch becomes a release blocker or an explicit product decision.

### 3. Prove that old APIs are gone from the current tree

- Search current code, tests, docs, and scripts for old route names, old `/api/` paths, and stale client calls.
- Create one explicit list of supported local API routes and other network entrypoints and use it as the release baseline.
- Verify that nested route mounts, proxy paths, and app-server forwarding do not expose endpoints missing from the release baseline.
- Remove dead routes, or gate local-only routes so they are not exposed by default in normal open-source usage.
- Keep documented supported local API routes available on loopback for local LLM apps, agents, scripts, the browser UI, and the desktop app.
- Update docs so only supported public or local-only routes remain documented.
- Add focused tests where useful so removed routes do not silently come back later.
- Defer the final supported-local-API manifest, public local API docs, and manifest regression tests until after the current route surface has been cleaned and reviewed.

### 4. Audit git history for old APIs and sensitive material

- Findings report: [`plans/openSourceSecretsHistoryFindings.md`](plans/openSourceSecretsHistoryFindings.md).
- Use history review to estimate risk and catch obvious leaks, not as the only safety control. Do not rely on proving that every old API use has been found.
- Review all reachable refs, not just the current branch: branches, tags, and any release branches that will remain visible.
- Search history for old route names, path patterns, internal admin/debug endpoints, and old client calls.
- Scan history for secrets and sensitive infra details: API keys, bearer tokens, SSH material, private URLs, internal IPs, hostnames, stack roots, cluster aliases, and backup paths.
- Include docs, scripts, Dockerfiles, compose files, CI config, and release helpers in the history audit, not just `src/`, because operational leakage often sits outside product code.
- Produce a finding log with: risk type, commit hash, file path, owner, severity, disposition, whether the secret or route is still active, the required remediation, and the evidence that closes the finding.

### 5. Decide how to handle history findings

- Preferred path: do not publish the existing history at all. Publish a new public repo or orphaned clean-history branch from the audited snapshot.
- If a real secret ever existed in git history, rotate or revoke it first. History rewrite comes after rotation, not before.
- If history contains only dead internal endpoints with no still-usable secret or credential, decide whether the disclosure risk is still too high to keep.
- Rewrite history only if there is a strong need to preserve some portion of the old history in the public repo.
- If history cleanup becomes too risky or too invasive, keep the original repo private and publish only the clean public mirror.
- After any rewrite or clean export, re-run the full history scan before publishing.

### 6. Audit configuration, secrets, and local data flows

- Inventory `process.env` usage, UI-stored provider settings, token storage, and any config that could capture real credentials.
- Inventory `LOG_DIR`, `LOG_LEVEL`, `LOG_STDERR_LEVEL`, and `FORSKA_RUNTIME_PROFILE` usage so public docs and sample commands do not expose machine-local paths or private runtime-profile conventions.
- Confirm that normal local development does not require committing `.env` files, private tokens, or machine-specific paths.
- Replace sensitive examples in docs and scripts with placeholders.
- Check whether exported sample data, logs, fixtures, snapshots, or generated artifacts contain real article content, PHI, API responses, or private metadata.
- Review whether runtime data under ignored paths has ever been copied into tracked files, tests, or docs.
- Audit the structured runtime JSONL payload shape, filename pattern, and 7-day retention behavior to confirm no secrets, article payloads, or private machine metadata are intended for redistribution or sample docs.

### 7. Audit operational and debug surfaces

- Review all admin, debug, status, proxy, database snapshot, and machine-observability routes.
- Decide which of these should be removed entirely, which should remain local-only, and which need stronger gating.
- Review every listener and proxy entrypoint, including `src/server/serverMain.ts` and `src/appServerMain.ts`, and record the default bind interfaces.
- Review bootstrap entrypoints that install runtime logging and process identity, including `src/server/index.ts`, `src/server/serverMain.ts`, `src/appServer.ts`, `src/appServerMain.ts`, and any dedicated bootstrap modules, so the release inventory covers startup-time logging behavior as well as HTTP routes.
- Confirm the supported OSS flow binds only to loopback by default, or document and explicitly justify any broader bind. Any wider default exposure is a release blocker.
- Review CORS, desktop-mode exceptions, and writer-proxy behavior to ensure the default network posture stays narrow.
- Remove or move operational scripts that are useful only inside non-public environments.

### 8. Audit licensing, data rights, and publishing obligations

- Pick an explicit project license and verify that dependencies, bundled assets, model integrations, and docs are compatible with that choice.
- Confirm that no private data, licensed PDFs, restricted datasets, or unpublished prompts are included in tracked files.
- Decide whether any medical, research, or model-use disclaimers should be part of the public release.
- Confirm the existing `LICENSE`, then add `SECURITY.md` and contributor guidance before opening the repo broadly.

### 9. Produce the release packet and go/no-go review

- Assemble the final evidence set: route inventory, history finding log, secret rotation log, kept-versus-removed script list, and public-repo scope decision.
- Make one explicit go/no-go decision with blockers sorted into must-fix-before-open and can-fix-after-open.
- If the answer is go, publish from the audited branch or clean mirror only.
- If the answer is no, keep the repo private and turn the blocker list into tracked implementation work.

### 10. Establish public-repo guardrails

- Add a fresh public CI/workflow set rather than copying private automation blindly.
- Run secret scanning on pull requests and on the default branch, and add checks that removed or moved docs, remote helpers, and restricted sample data do not re-enter the Forska repo.
- As one of the last cleanup steps, implement the supported local API manifest from `plans/supportedLocalApi.md` and treat unexpected endpoint, listener, owner/proxy, or CORS changes as review failures.
- Add a fresh-clone smoke test based only on public docs so new contributors can validate the supported OSS flow without private infra access.
- Require explicit review before adding new Dockerfiles, remote-run docs, infra scripts, or release helpers to the public repo.

### 11. Finalize the public release scope

- Default to a fresh public mirror exported from an audited snapshot, with no inherited private commit history.
- Treat preserving the existing git history as an exception that requires a strong reason and a separate cleanup plan.
- Create a final file-action table for the repo: keep as-is, rewrite, remove, or move to another repo.
- Record destination repo/path for moved material, especially operational runbooks, backup flows, cluster launch helpers, remote/HPC Docker helpers, unpublished datasets, and anything tied to private infrastructure.
- Rewrite or remove anything that remains in Forska but still contains internal hostnames, stack roots, unsupported run commands, or sensitive data.
- Reconcile the docs and Docker/publication-artifact decisions from Workstream 1 with the route, secret, licensing, history, and guardrail findings.
- Record a simple release rule: public contributors should be able to clone, install, migrate, and run locally without private infra access.

## Suggested Audit Commands

- Current tree network surface inventory: `rg "/api/|Routes|listen\\(" src/server src/appServer.ts src/appServerMain.ts docs scripts`
- Current tree transitive mount search: `rg "\\.use\\([A-Za-z].*Routes" src/server`
- Current tree hotspot search: `rg "AdminInvestigate|ArticleAdmin|DuckdbStudio|NvidiaSmi|LlmStatus|ApiProxy|Tokens|Users" src docs scripts`
- Publication artifact search: `rg "ssh|STACK_ROOT|SSH_ALIAS|docker" README.md docs scripts package.json Dockerfile*`
- Runtime logging surface search: `rg "LOG_DIR|LOG_LEVEL|LOG_STDERR_LEVEL|FORSKA_RUNTIME_PROFILE|runtimeLogger|logs/runtime" src docs scripts`
- History search by path or string: `git log --all -- src/server src/appServer.ts src/appServerMain.ts docs scripts Dockerfile*` and `git log --all -S"/api/" -- src/server src/appServer.ts src/appServerMain.ts docs scripts`
- Full-history secret scan: run a dedicated tool such as `gitleaks` or `trufflehog` against all refs, then manually review hits
- Rewrite option if needed: `git filter-repo` or BFG, followed by a fresh scan of all remaining refs

## Deliverables

- A current API and network-surface matrix with supported-local/diagnostic/sensitive/internal/debug/remove decisions, bind notes, and transitive mount coverage
- A late-stage supported local API manifest and documentation, based on `plans/supportedLocalApi.md`, covering local LLM apps, agents, scripts, browser UI, and desktop app callers
- A git-history findings report covering secrets, old endpoints, and sensitive infra details, with owner, severity, disposition, and closure evidence
- A release-scope file-action table covering keep as-is, rewrite, remove, and move decisions
- A decision memo that defaults to publishing from a fresh clean mirror and explains any exception
- A public-repo file decision checklist for files, scripts, docs, and moved material
- A kept-versus-removed publication artifact list covering scripts, Dockerfiles, remote docs, CI, and release helpers
- A public-repo guardrail plan for secret scanning, moved/removed-path checks, and unexpected route or listener changes
- A logging-surface note covering runtime JSONL env vars, ignored paths, payload shape, bootstrap entrypoints, and retention behavior in the published repo
- Public-release docs: existing `LICENSE`, new `SECURITY.md`, contributor guidance, and rewritten README updates

## Exit Criteria

- Every currently mounted route, proxy entrypoint, and listener has an owner and a classification.
- Every documented local integration route is listed in the supported local API manifest, and every unlisted mounted route is explicitly internal, debug, sensitive, or removed before release.
- No current default route or listener exposure contradicts the intended single-user local-first product stance.
- Supported OSS listeners bind only to loopback by default, or every broader bind has an explicit documented exception.
- No unrevoked secret remains reachable in the history that will be public.
- The published public repo contains only clean audited history, or an explicitly justified and re-scanned exception.
- Public docs, scripts, and kept publication artifacts work without private infrastructure.
- A fresh clone can bootstrap the supported OSS flow from public docs only.
- The repo has an explicit license, a security disclosure path, and active public guardrails.

## Touched Layers

- server
- client/docs
- scripts
- git history and release ops

## Quality Gates

- `bun run lint`
- Targeted `bun test` for any touched route files under `src/server/routes`
- `bun run build` if client or route-consumer UI changes land during the cleanup
- Manual verify: the network surface inventory covers `src/server/index.ts`, `src/server/serverMain.ts`, `src/appServer.ts`, `src/appServerMain.ts`, nested mounts, and proxy entrypoints
- Manual verify: supported OSS listeners bind only to loopback by default, or every broader bind is documented and approved
- Manual verify: full-history secret and sensitive-artifact scans rerun clean for all refs that could become public, or every hit is rotated/revoked and removed from published refs
- Manual verify: the final diff matches the file-action table, including scripts, Dockerfiles, remote docs, and moved material
- Manual verify: a fresh clone can `bun install`, `bun run db:mig`, `bun run build`, and boot the supported local OSS flow using only public docs
- Manual verify: public-repo guardrails are enabled for secret scanning, moved/removed-path checks, and unexpected route or listener changes
