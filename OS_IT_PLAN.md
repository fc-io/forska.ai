# Open Source Investigation Plan

## Goal

- Decide whether Forska can be published safely as open source, and if not, produce a concrete blocker list with remediation order.
- Treat security as the primary release gate, especially current API exposure, old internal APIs in git history, leaked secrets, and internal infra details.
- Do not publish until both the current tree and reachable history have been reviewed.

## Current Repo Signals

- `README.md` says the product goal is a local-first single-user app with no admin role, but `src/server/serverMain.ts` still mounts routes such as `AdminInvestigateRoutes`, `ArticleAdminRoutes`, `DuckdbStudioRoutes`, `NvidiaSmiRoutes`, `LlmStatusRoutes`, `ApiProxyRoutes`, `TokensRoutes`, and `UsersRoutes`.
- `src/appServerMain.ts` is a second HTTP listener and proxies `/api/*` to the API server, while `src/appServer.ts` is its runtime bootstrap wrapper, so the public network surface is broader than `src/server/routes/` alone.
- `package.json` still includes operational scripts for backups, remote DB merge flows, and SSH-based workflows that may not belong in a public repo.
- `.gitignore` already excludes `.env`, `data/`, `.secrets/`, logs, and imported assets, which is a good start, but that does not say anything about older commits.
- The repo has a root `LICENSE`, but does not currently have `SECURITY.md` or `CONTRIBUTING.md`.
- There is no current `.github/` workflow scaffold, so public-repo guardrails such as secret scans and denylisted-path checks will need to be added explicitly rather than assumed.

## Main Questions To Answer

- Which code, docs, scripts, and assets are safe to publish as-is?
- What are all current network entrypoints, transitively mounted routes, proxy paths, and default bind interfaces?
- Which current API routes are real product surface versus internal-only/debug/operator surface?
- Which local API routes should be stable and documented for local LLM apps, agents, scripts, the browser UI, and the desktop app?
- Which publication artifacts are safe to publish: Dockerfiles, compose files, CI config, remote-run docs, and release helpers?
- Which old routes still appear in git history, tags, or release artifacts?
- Have any secrets, internal URLs, SSH aliases, hostnames, tokens, or private datasets ever been committed?
- Is it safer to rewrite history or to publish a new clean public repo from an audited snapshot?

## Core Release Principle

- Default to a fail-closed release: if a route, script, doc, asset, or historical secret is not clearly safe for public distribution, treat it as blocked until reviewed.
- Do not confuse local integration with public internet exposure. The intended open-source shape includes a documented API for local apps on the same machine, while unsupported internal/debug/operator routes stay clearly separated.
- Assume exhaustive discovery of every old API use in git history is not realistic. The default public-release path should therefore avoid publishing the existing private history.

## Preferred Public Release Path

1. Keep the current repo private.
   - Do not expose existing branches, tags, or commit history.
   - Treat the private repo as the internal source of truth and audit workspace.
2. Create a new public repo from a clean audited snapshot.
   - Export from one reviewed commit only, or from an orphan clean-history branch.
   - Publish only after the snapshot has passed the route, secret, docs, and infra review.
3. Carry over only the minimum safe public material.
   - Include app and server source, tests, migrations, package metadata, normal local-dev scripts, and sanitized docs.
   - Add fresh public-facing repo docs: `LICENSE`, `SECURITY.md`, `CONTRIBUTING.md`, and an updated `README.md`.
   - Exclude private ops scripts, HPC and backup helpers, internal-only runbooks, private datasets, generated runtime data, and any file whose purpose is unclear.

## Minimum Public Carry-Over Checklist

- Include only what is needed for the public OSS flow: `bun install`, `bun run db:mig`, `bun run dev:server`, `bun run dev:app`, `bun run build`, and relevant `bun test` commands.
- Include reviewed product code under `src/`, but only after the route and surface audit removes or gates internal-only endpoints.
- Include a supported local API contract based on `plans/supportedLocalApi.md`, so local LLM apps, agents, scripts, browser UI, and desktop app know which routes are stable. Implement that contract last, after route cleanup and sensitive-route decisions are complete.
- Include DuckDB migration files under `src/db/duckdbMigrations/` and any other schema/runtime files required for first boot.
- Include tests that validate the public product surface, as long as fixtures and snapshots are sanitized.
- Include root build and tooling files needed for public development, such as `package.json`, `bun.lock`, `tsconfig.json`, `vite.config.ts`, `eslint.config.ts`, `playwright.config.ts`, `.gitignore`, `.prettierrc.js`, `.prettierignore`, and `index.html`.
- Include only the subset of `scripts/` required for normal local OSS development, setup, migration, build, test, and packaging.
- Include sanitized public docs only: `README.md`, local-run docs, architecture notes that reveal no sensitive internals, and the new `LICENSE`, `SECURITY.md`, and `CONTRIBUTING.md`.
- Include `Dockerfile` or compose files only if they support a real public workflow, bind safely by default, and contain no private infra assumptions.
- Exclude all old git history, private branches, and private tags from the public repo seed.
- Exclude runtime and generated material: `.env*`, `data/`, `cache/`, `dist/`, `desktopBuild/`, `node_modules/`, `test-results/`, `tmp/`, logs, and local machine artifacts.
- Exclude structured runtime telemetry such as `logs/runtime/` JSONL files and desktop `backend.log`; confirm those paths stay gitignored and never enter the public seed.
- Exclude private infra and ops material by default: remote backup helpers, cluster launch helpers, and any script tied to SSH aliases, stack roots, or private environments.
- Exclude non-public publication artifacts by default: `Dockerfile.sglang`, `Dockerfile.sglang-gateway`, remote-only compose overrides, remote-run docs, CI or release config with private runners or registries, and any release helper that assumes private infrastructure.
- Exclude ambiguous or internal planning material by default: root plan files, `plans/`, `future/`, `tasks/`, and any document that is not clearly meant for public users or contributors.
- Exclude all datasets, imported assets, cached PDFs, snapshots, and example files unless they are explicitly reviewed, licensed for redistribution, and scrubbed of sensitive content.
- If a file is not clearly needed for public users or contributors, leave it out of the first public repo seed and add it later only after review.

## Workstreams

### 1. Define the public release scope

- Default to a fresh public mirror exported from an audited snapshot, with no inherited private commit history.
- Treat preserving the existing git history as an exception that requires a strong reason and a separate cleanup plan.
- Start from a minimum public carry-over set, not from the full private repo contents.
- Create an allowlist for what belongs in the public repo: source, tests, docs, sample data, migrations, and scripts needed for normal local development.
- Create a denylist for what stays private: operational runbooks, backup flows, cluster launch helpers, internal hostnames, unpublished datasets, and anything tied to private infrastructure.
- Inventory publication artifacts separately: Dockerfiles, compose files, CI/workflow config, release helpers, and remote-run docs. Mark each keep/remove/private.
- Record a simple release rule: public contributors should be able to clone, install, migrate, and run locally without private infra access.

### 2. Inventory the current server and API surface

- Use `plans/supportedLocalApi.md` as the companion decision framework for deciding which localhost routes are stable local integration APIs versus internal/debug implementation details. Do not implement the manifest/docs/regression checks from that plan until late-stage cleanup.
- Build a network surface inventory from `src/server/index.ts`, `src/server/serverMain.ts`, `src/appServer.ts`, `src/appServerMain.ts`, every file under `src/server/routes/`, and any nested or transitively mounted routes.
- For each listener, proxy entrypoint, or route, record: bind host, path, methods, mounted role, proxy behavior, client caller, local integration caller, data touched, whether it is required for the product, and whether it is safe to keep in the public seed.
- Classify each route into one of: supported local API, local diagnostics API, sensitive local API, internal runtime API, maintenance/debug API, or remove from public seed.
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
- Remove or quarantine operational scripts that are useful only inside private environments.

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
- Run secret scanning on pull requests and on the default branch, and add denylisted-path checks for private docs, remote helpers, and restricted sample data.
- As one of the last cleanup steps, implement the supported local API manifest from `plans/supportedLocalApi.md` and treat unexpected endpoint, listener, owner/proxy, or CORS changes as review failures.
- Add a fresh-clone smoke test based only on public docs so new contributors can validate the supported OSS flow without private infra access.
- Require explicit review before adding new Dockerfiles, remote-run docs, infra scripts, or release helpers to the public repo.

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
- A release-scope allowlist and private-material denylist
- A decision memo that defaults to publishing from a fresh clean mirror and explains any exception
- A public-repo seed checklist for the minimum safe files, scripts, and docs to carry over
- A kept-versus-removed publication artifact list covering scripts, Dockerfiles, remote docs, CI, and release helpers
- A public-repo guardrail plan for secret scanning, denylisted-path checks, and unexpected route or listener changes
- A logging-surface note covering runtime JSONL env vars, ignored paths, payload shape, bootstrap entrypoints, and retention behavior in the public seed
- Public-release docs: existing `LICENSE`, new `SECURITY.md`, contributor guidance, and sanitized README updates

## Exit Criteria

- Every currently mounted route, proxy entrypoint, and listener has an owner and a classification.
- Every documented local integration route is listed in the supported local API manifest, and every unlisted mounted route is explicitly internal, debug, sensitive, or removed from the public seed.
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
- Manual verify: full-history secret and sensitive-artifact scans rerun clean for all refs that could become public, or every hit is rotated/revoked and excluded from the public seed
- Manual verify: public seed allowlist and denylist diff is reviewed, including scripts, Dockerfiles, and remote docs
- Manual verify: a fresh clone can `bun install`, `bun run db:mig`, `bun run build`, and boot the supported local OSS flow using only public docs
- Manual verify: public-repo guardrails are enabled for secret scanning, denylisted-path checks, and unexpected route or listener changes
