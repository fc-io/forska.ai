# Open Source Secret And Infra History Findings

## Scope

- Audit date: 2026-05-27.
- Scope covered: current visible working tree, tracked current tree, and all local reachable refs.
- Refs covered: 47 refs, including local branches, remote-tracking branches, `origin/HEAD`, and `refs/stash`.
- Commits covered: 2,861 commits from `git log --all`.
- Tags covered: none present locally.
- Secret scanner limitation: `gitleaks`, `trufflehog`, and `detect-secrets` were not installed; Docker was installed but the daemon was unavailable. This report is therefore a manual `git`/`rg` audit, not a replacement for the required dedicated scanner pass before public release.

## Summary

- No known-format cloud/API tokens, bearer tokens, or private key blocks were found in current visible files or history patch scans.
- No `.env`, private key, kubeconfig, or credential filename was found in historical file names.
- Current tracked files still contain public-release blockers: `.claude/settings.json`, tracked research/sample/PDF assets, private-path examples, private-IP examples, and optional SSH/GPU telemetry surfaces.
- Full history contains substantial old private infra and remote-ops material in docs, scripts, Docker/compose files, sbatch files, and backup/sync helpers. This confirms the preferred release path in `plans/old/OS_IT_PLAN.md`: publish from a clean audited snapshot, not the existing history.

## Findings

| ID | Risk Type | Severity | Source | Commit | File Path | Owner | Still Active? | Disposition | Required Remediation | Closure Evidence |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| OSH-001 | Current-tree credential-looking local tool config | Medium | Current tree manual scan | `HEAD` | `.claude/settings.json` | Release/docs owner | Yes, tracked current file | Remove from public snapshot | Remove `.claude/` from the public mirror or replace with public-safe opencode/agent guidance outside this repo. Values reviewed are local/dev examples, not known external secrets. | Current token/private-key scans were clean; file read confirmed only local dev credential-looking values. |
| OSH-002 | Tracked datasets, article PDFs, and sample medical data | High | Current tree path and infra scan | `HEAD` | `assets/**` | Data/licensing owner | Yes, 79 tracked asset files | Remove or move unless explicitly licensed and scrubbed | Remove `assets/covidence_study/**`, `assets/user_uploaded_article_pdfs/**`, and FHIR NDJSON sample assets from the public snapshot unless a separate licensing/data review approves them. | Current scan found asset files and private-IP pattern hits in Covidence CSVs; no known-format tokens found in asset history. |
| OSH-003 | Current local machine path examples | Medium | Current tree manual scan | `HEAD` | `plans/old/APP_PLAN_TODO_SPIKE.md`, `src/utils/runtimeProfile.test.ts`, `src/server/services/projectTransfer/projectTransferRedaction.test.ts`, `src/server/utils/getDuckdbPath.test.ts`, `src/server/utils/getCodexAppServerClient.test.ts` | Code/docs owner | Yes | Rewrite or omit | Replace real usernames and machine-local paths with neutral placeholders before publishing files that remain in Forska. Tests that intentionally validate redaction can use `/Users/example` or `/home/example`. | Current scan found 5 files with private-path patterns; reviewed representative hits. |
| OSH-004 | Current private-IP, SSH, and remote GPU telemetry surface | Medium | Current tree manual scan | `HEAD` | `src/server/cron/nvidiaSmi.ts`, `src/server/utils/getInferenceRuntimeConfig.test.ts`, `src/app/routes/+providers/providerRuntimeStateCard.tsx`, active plan files | Runtime/API owner | Yes | Rewrite/gate or remove | Replace private-IP examples with documentation-safe placeholders, keep optional SSH/nvidia-smi telemetry disabled by default, and complete the route/runtime surface decision before public release. | Current scan found 3 files with private-IP patterns, 2 files with host-alias terms, and 11 files with ops markers. |
| OSH-005 | Historical private infra and remote ops material | High | Full-history manual scan | Representative commits: `8b86ec315848`, `a85f16cfbd12`, `1ab458ba96f6`, `2335b5593cb5`, `db2f5913363b`, older 2025-10 through 2026-04 commits | Historical `docs/README_*REMOTE*`, `docs/README_*ALVIS*`, `scripts/*Remote*`, `scripts/*Sglang*`, `scripts/mn5*`, `old_sbatch/**`, `*.sbatch`, `Dockerfile.sglang`, `docker-compose.yml`, `package.json` | Release owner | Active in history; mostly removed from current tree | Publish only via clean mirror | Do not publish existing refs/history. If any history is preserved, filter/remove old remote docs, sbatch files, Docker/compose infra, SSH aliases, stack roots, backup paths, and sync helpers, then rescan. | `git log --all -G` found extensive private-infra and ops history across docs/scripts/package/Docker paths. |
| OSH-006 | Historical credential literals and local service defaults | Medium | Full-history manual scan | Representative commits: `7c48a162c926`, `c3deca92e4d8`, `a85f16cfbd12`, old Docker/Postgres/ClickHouse/PeerDB/S3 helper history | Historical README/docs/scripts/config files | Release/security owner | Active in history; current known-format scans clean | Clean mirror; rotate if any value was real | Treat historical local service passwords, build args, and env examples as private-history material. Confirm whether any were used against non-local infrastructure; rotate/revoke before any history preservation. | History patch scan found redacted credential-literal patterns but no known-format cloud/API tokens or private keys. |
| OSH-007 | Known-format secret and private-key scan result | Info | Current and history manual scans | All scanned refs | Repo-wide | Security owner | No evidence of active known-format secret | Keep evidence; rerun with scanner | No rotation required from this manual evidence alone, but this does not close the dedicated scanner gate. | Current and history scans returned no known-format API keys, bearer tokens, or private key headers. Sensitive filename scan returned no `.env`, key, kubeconfig, or credential files. |
| OSH-008 | Dedicated secret scanner coverage gap | Medium | Tooling check | N/A | N/A | Release/security owner | Yes | Block release until complete | Install/run `gitleaks` and `trufflehog` against all refs and current tree with redacted reports kept outside git. Triage every hit before go/no-go. | `command -v` found only `rg`; Docker-based scanner attempt failed because the Docker daemon was unavailable. |

## Evidence Commands

- `git status --short`
- `git branch --all --no-color`
- `git tag --list`
- `git for-each-ref --format='%(refname)'`
- `git log --all --format='%H'`
- `command -v gitleaks; command -v trufflehog; command -v detect-secrets; command -v rg`
- `docker run --rm zricethezav/gitleaks:latest --help`
- `rg --hidden --glob '!.git'` scans for known-format tokens, private key headers, bearer tokens, private paths, private IPs, host aliases, and ops markers.
- `git log --all --patch --no-ext-diff` piped to `rg` for known-format tokens, private key headers, bearer tokens, and credential literals.
- `git log --all --extended-regexp -G` for private infra, private IP, SSH, remote ops, and credential-word history.
- `git log --all --name-only --format=''` for sensitive filename history.
- `git ls-files 'assets/**'` for current tracked data assets.

## Quality Gates

- [x] Manual verify: current visible tree scanned for known-format API tokens, bearer tokens, private key headers, private paths, private IPs, host aliases, and ops markers.
- [x] Manual verify: full local reachable history scanned for known-format API tokens, bearer tokens, private key headers, credential literals, private infra patterns, ops markers, and sensitive filenames.
- [x] Manual verify: docs, scripts, Docker/compose, CI/workflow paths, release/helper paths, and `src/` were included in history searches.
- [ ] Release gate: run `gitleaks` all-history and current-tree scans across all refs.
- [ ] Release gate: run `trufflehog` all-history scans across all refs.
- [ ] Release gate: remediate current-tree blockers or publish from a clean snapshot that excludes them.
- [ ] Release gate: if any historical credential value was real outside local dev, rotate/revoke it before any history rewrite or public exposure.

## Recommendation

Keep the current repository and all existing refs private. Publish only from a clean audited snapshot after current-tree blockers are removed or rewritten and dedicated secret scanners have rerun clean.

## Touched Layers

- docs
- scripts
- server/runtime
- data/assets
- git history and release ops
