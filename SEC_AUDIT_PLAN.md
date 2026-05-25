# Security Audit Plan

This plan expands the security-focused open-source blockers from `OS_IT_PLAN.md`: git-history and sensitive-material audit, plus configuration, secrets, local data, and runtime logging audit.

## Release Principle

- Treat any unreviewed secret, credential-like value, private hostname, private path, runtime payload, dataset, log, or sample artifact as blocked for public release.
- Prefer publishing from a clean audited snapshot. Do not rely on history scanning as the only safety control.
- Audit reports can contain sensitive evidence. Keep generated reports out of git and redact report output by default.

## Scope

- All reachable git refs that could become public: local branches, remote-tracking branches, tags, and release branches.
- Current tracked files under product code, docs, root plans, tasks, scripts, migrations, tests, fixtures, config, hidden tool config, package metadata, CI/workflow files, Docker/compose files, and publication artifacts.
- Ignored and generated local paths likely to hold sensitive or publishable material that could accidentally be copied into tracked files: `data/`, `cache/`, `logs/`, `tmp/`, `.tmp/`, `.temp/`, `temp/`, `test-results/`, `coverage/`, `out/`, `dist/`, `desktopBuild/`, `desktopArtifacts/`, `.desktopBuild/`, `.desktopArtifacts/`, `.cache/`, `.secrets/`, `assets/article_pdfs/`, `assets/user_uploaded_article_pdfs/`, `assets/covidence_*`, `assets/structured_file_imports/`, `backups/`, `openalex_snapshot/`, `models/`, `pgdata/`, `init-db/`, and runtime JSONL output.
- Config and secret flows: `process.env`, UI-stored provider settings, provider API keys, token storage, local binary paths, runtime profiles, logging paths, and sample commands.

## Out Of Scope

- Route cleanup implementation. Route decisions feed into this audit, but route gating/removal belongs in the route-surface workstream.
- History rewrite implementation. This plan produces findings and remediation requirements; rewrite or clean-mirror publishing is decided after findings are reviewed.
- Publishing the public repo. The output here is evidence for the final go/no-go packet.

## Special Audit Software

Use special audit software. Manual search is not enough.

| Tool                                                       | Required | Purpose                                                                                               | Notes                                                                                                                               |
| ---------------------------------------------------------- | -------- | ----------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `gitleaks`                                                 | Yes      | Primary all-history and current-tree secret scan.                                                     | Run locally with redacted JSON reports outside the repo.                                                                            |
| `trufflehog`                                               | Yes      | Independent all-history secret scan with verification where possible.                                 | Run locally; keep JSONL output outside the repo and treat it as raw sensitive evidence unless the installed version redacts output. |
| `rg` and `git log -S`/`-G`                                 | Yes      | Manual review for old APIs, private infra strings, logging paths, and project-specific terms.         | Required because generic secret scanners miss project-specific leakage.                                                             |
| GitHub secret scanning or equivalent public-repo guardrail | Later    | Continuous public-repo protection after the clean mirror exists.                                      | Do not replace the pre-release local scan with this.                                                                                |
| `detect-secrets`, `git-secrets`, or Semgrep custom rules   | Optional | Extra scan if `gitleaks` or `trufflehog` produce ambiguous coverage or if CI needs a baseline format. | Add only if it catches a known gap.                                                                                                 |

Install tools outside the repo, for example with Homebrew:

```bash
brew install gitleaks trufflehog
gitleaks version
trufflehog --version
```

Before running tools, confirm current CLI flags with `gitleaks --help` and `trufflehog git --help`. If the installed `trufflehog` cannot redact JSONL output, keep the raw JSONL local only and copy only redacted summaries into findings.

## Audit Workspace

- Refresh remote refs, then create an out-of-tree local report folder. The commands below assume `AUDIT_DIR` remains exported:

```bash
set -euo pipefail

git fetch --all --tags --prune
export REPO_ROOT="$(cd "$(git rev-parse --show-toplevel)" && pwd -P)"
export AUDIT_DIR="${AUDIT_DIR:-../forska-security-audit}"
AUDIT_DIR_ABS=""
if test -e "$AUDIT_DIR"; then
  AUDIT_DIR_ABS="$(cd "$AUDIT_DIR" 2>/dev/null && pwd -P)"
else
  AUDIT_PARENT="$(cd "$(dirname "$AUDIT_DIR")" 2>/dev/null && pwd -P)"
  if test -n "$AUDIT_PARENT"; then
    AUDIT_DIR_ABS="$AUDIT_PARENT/$(basename "$AUDIT_DIR")"
  fi
fi
if test -z "$AUDIT_DIR_ABS"; then
  echo "Stop: AUDIT_DIR parent must exist and resolve outside the repository." >&2
  exit 1
fi
export AUDIT_DIR="$AUDIT_DIR_ABS"
case "$AUDIT_DIR/" in
  "$REPO_ROOT"/*)
    echo "Stop: AUDIT_DIR must resolve outside the repository before reports are written." >&2
    exit 1
    ;;
esac
export AUDIT_TREE="$AUDIT_DIR/current-tree"
mkdir -p "$AUDIT_DIR/reports" "$AUDIT_DIR/findings"
git status --short > "$AUDIT_DIR/reports/working-tree-status.txt"
if test -s "$AUDIT_DIR/reports/working-tree-status.txt"; then
  cat "$AUDIT_DIR/reports/working-tree-status.txt" >&2
  echo "Stop: commit, remove, or explicitly exclude these changes before auditing HEAD." >&2
  exit 1
fi
git --version > "$AUDIT_DIR/reports/git-version.txt"
rg --version > "$AUDIT_DIR/reports/rg-version.txt"
gitleaks version > "$AUDIT_DIR/reports/gitleaks-version.txt"
trufflehog --version > "$AUDIT_DIR/reports/trufflehog-version.txt"
rm -rf "$AUDIT_TREE"
mkdir -p "$AUDIT_TREE"
git archive --format=tar HEAD | tar -xf - -C "$AUDIT_TREE"
git remote -v > "$AUDIT_DIR/reports/remotes.txt"
git rev-parse HEAD > "$AUDIT_DIR/reports/audit-head.txt"
git for-each-ref --format="%(refname)" refs/heads refs/remotes refs/tags > "$AUDIT_DIR/reports/reachable-refs.txt"
git ls-remote --heads --tags origin > "$AUDIT_DIR/reports/origin-refs.txt"
git ls-tree -r -z --name-only HEAD > "$AUDIT_DIR/reports/tracked-current-tree-files.zlist"
```

- Do not commit raw scanner reports.
- Do not paste unredacted secrets into markdown findings.
- Stop before writing reports if `AUDIT_DIR` resolves inside the repo. Do not rely on `.git/info/exclude` to protect raw audit output from accidental publication.
- Stop if `working-tree-status.txt` is non-empty. The current-tree archive is `HEAD`, so uncommitted product edits must be committed, removed, or explicitly excluded from the release candidate before scanning.
- Run current-tree content scans against `$AUDIT_TREE`, not the live working directory, so ignored local data and audit reports do not get scanned as product content.
- Use `rg --hidden --no-ignore` for `$AUDIT_TREE` scans. The archived tree contains `.gitignore`, but tracked ignored files still need audit coverage.
- Treat raw `rg`, `git log`, `gitleaks`, and `trufflehog` report files as sensitive evidence. Keep them outside git and copy only redacted summaries into findings.
- Record tool versions, command lines, scan date, scanned commit, scanned refs, and the `$AUDIT_TREE` path.

## Workstream A: Git History And Sensitive Material

1. Inventory reachable refs.
   - Confirm which refs would be included in a public release.
   - Record all branches and tags scanned.
   - Compare fetched local refs against `origin-refs.txt`; if remote fetch or listing fails, record the reason and treat ref coverage as unresolved.
   - Mark refs that will stay private separately from refs that could become public.

2. Run all-history secret scanners.

```bash
set -euo pipefail

gitleaks git --source . --log-opts="--all" --redact --report-format json --report-path "$AUDIT_DIR/reports/gitleaks-history.json"

while IFS= read -r ref; do
  report_name="$(printf '%s' "$ref" | tr '/:' '__')"
  trufflehog git "file://$PWD" --branch "$ref" --json --no-update > "$AUDIT_DIR/reports/trufflehog-history-$report_name.raw.jsonl"
done < "$AUDIT_DIR/reports/reachable-refs.txt"
```

If the installed `trufflehog git --help` shows that full ref names are not accepted by `--branch`, rerun `trufflehog` with the installed version's equivalent per-ref option. Do not replace the per-ref run with a single default-branch local scan.

3. Run a current-tree scan.

```bash
set -euo pipefail

gitleaks dir "$AUDIT_TREE" --redact --report-format json --report-path "$AUDIT_DIR/reports/gitleaks-current-tree.json"
```

4. Run manual history searches for API and infra leakage.

```bash
git log --all --date=short --name-only --format='%H%x09%ad%x09%s' -S"/api/" > "$AUDIT_DIR/reports/history-api-paths.txt"
git log --all --extended-regexp --date=short --name-only --format='%H%x09%ad%x09%s' -G"AdminInvestigate|ArticleAdmin|DuckdbStudio|NvidiaSmi|LlmStatus|ApiProxy|TokensRoutes|UsersRoutes|RuntimeAssets|ProviderConnectionsRoutes|ProviderModelsRoutes" > "$AUDIT_DIR/reports/history-sensitive-route-names.txt"
git log --all --extended-regexp --date=short --name-only --format='%H%x09%ad%x09%s' -G'https?://|(^|[^0-9])10\.|(^|[^0-9])192\.168\.|(^|[^0-9])172\.(1[6-9]|2[0-9]|3[0-1])\.' > "$AUDIT_DIR/reports/history-url-private-ip.txt"
git log --all --date=short --name-only --format='%H%x09%ad%x09%s' -S"STACK_ROOT" > "$AUDIT_DIR/reports/history-stack-root.txt"
git log --all --date=short --name-only --format='%H%x09%ad%x09%s' -S"SSH_ALIAS" > "$AUDIT_DIR/reports/history-ssh-alias.txt"
git log --all --date=short --name-only --format='%H%x09%ad%x09%s' -S"LOG_DIR" > "$AUDIT_DIR/reports/history-log-dir.txt"
git log --all --date=short --name-only --format='%H%x09%ad%x09%s' -S"FORSKA_RUNTIME_PROFILE" > "$AUDIT_DIR/reports/history-runtime-profile.txt"
```

5. Run current-tree manual scans for project-specific sensitive strings.

```bash
rg -n --hidden --no-ignore "AKIA|AIza|sk-|gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|glpat-[A-Za-z0-9_-]+|hf_[A-Za-z0-9]+|xox[baprs]-|BEGIN (RSA|OPENSSH|EC|PRIVATE) KEY|Bearer [A-Za-z0-9._-]+|api[_-]?key|secret|token|password|private[_-]?key" "$AUDIT_TREE" > "$AUDIT_DIR/reports/current-tree-secret-string-hits.raw.txt" || true
rg -n --hidden --no-ignore "ssh|hostname|STACK_ROOT|SSH_ALIAS|backup|cluster|internal|private|LOG_DIR|FORSKA_RUNTIME_PROFILE|logs/runtime|https?://|(^|[^0-9])10\\.|(^|[^0-9])192\\.168\\.|(^|[^0-9])172\\.(1[6-9]|2[0-9]|3[0-1])\\." "$AUDIT_TREE" > "$AUDIT_DIR/reports/current-tree-infra-string-hits.raw.txt" || true
```

6. Triage every scanner and manual-search hit.
   - Classify each hit as real secret, credential reference, private infra detail, old internal route, public-safe placeholder, false positive, or already-removed private-only history.
   - For real secrets, rotate or revoke before any history rewrite or clean export.
   - For private infra details, rewrite/remove current files and avoid publishing old history.
   - For old API/internal route history, decide whether clean-mirror publishing is enough or whether the old surface creates disclosure risk requiring extra remediation.

7. Produce a finding log with one row per finding.

| Field                        | Required                                                                      |
| ---------------------------- | ----------------------------------------------------------------------------- |
| Finding ID                   | Yes                                                                           |
| Risk type                    | Yes                                                                           |
| Severity                     | Yes                                                                           |
| Source tool or manual search | Yes                                                                           |
| Commit hash                  | Yes, when from history                                                        |
| File path                    | Yes                                                                           |
| Evidence summary             | Redacted only                                                                 |
| Owner                        | Yes                                                                           |
| Still active?                | Yes                                                                           |
| Public-release disposition   | Keep, rewrite, remove, move, rotate, revoke, or publish only via clean mirror |
| Closure evidence             | Yes                                                                           |

## Workstream B: Configuration, Secrets, Local Data, And Logging

1. Inventory environment variables and runtime profiles.

```bash
rg -n --hidden --no-ignore "process\\.env|Bun\\.env|LOG_DIR|LOG_LEVEL|LOG_STDERR_LEVEL|FORSKA_RUNTIME_PROFILE|runtimeLogger|logs/runtime" "$AUDIT_TREE" > "$AUDIT_DIR/reports/env-runtime-hits.raw.txt" || true
```

For each variable, record:

- Purpose.
- Whether it is required for normal local development.
- Whether it can contain secrets, private paths, or private hostnames.
- Public default or placeholder wording.
- Whether docs/scripts expose a private value.

2. Inventory provider credentials and token storage.

```bash
rg -n --hidden --no-ignore "provider|apiKey|api_key|secret|token|credential|auth|encrypt|keychain|localStorage|sessionStorage|indexedDB" "$AUDIT_TREE" > "$AUDIT_DIR/reports/provider-token-storage-hits.raw.txt" || true
```

For each flow, record:

- Storage location.
- Whether raw secrets are persisted.
- Whether responses can return secret values.
- Whether logs can include secret values.
- Whether public docs explain safe local setup without committed `.env` files.

3. Inventory local data, fixtures, exports, and generated artifacts.

```bash
git ls-tree -r --name-only HEAD | rg "fixture|fixtures|sample|example|snapshot|export|pdf|ndjson|jsonl|log|data|cache|tmp|artifact|backup|covidence|openalex|fhir|ehr|token|secret|credential|key|user_uploaded" > "$AUDIT_DIR/reports/tracked-artifact-paths.txt" || true
git ls-tree -r --name-only HEAD | rg -i "\.(zip|tar|tgz|gz|bz2|xz|7z|rar|pdf|docx|xlsx|pptx|sqlite|duckdb|db|parquet|arrow|png|jpe?g|webp|wasm|bin)$" > "$AUDIT_DIR/reports/tracked-binary-artifact-paths.txt" || true
git status --ignored --short > "$AUDIT_DIR/reports/git-status-ignored.txt"
find data cache logs tmp .tmp .temp temp test-results coverage out dist desktopBuild desktopArtifacts .desktopBuild .desktopArtifacts .cache .secrets assets/article_pdfs assets/user_uploaded_article_pdfs assets/covidence_2 assets/covidence_imports assets/covidence_running assets/covidence_study assets/structured_file_imports backups openalex_snapshot models pgdata init-db -type f -print 2>/dev/null > "$AUDIT_DIR/reports/local-generated-files.txt" || true
```

For each tracked or publishable artifact, decide:

- Keep as-is, rewrite, remove, or move.
- Whether it contains article content, PHI, PDFs, API responses, provider metadata, prompt text, model output, local paths, or machine identifiers.
- Whether redistribution rights are clear.
- Whether the artifact belongs in Forska or another repo.
- Whether binary, archive, office, image, database, and columnar artifacts were actually inspected. Do not treat a clean text `rg` scan as coverage for embedded content; extract archives, open structured formats with appropriate tooling, or remove/move the artifact before release.

4. Audit structured runtime logging.

```bash
rg -n --hidden --no-ignore "runtimeLogger|LOG_DIR|LOG_LEVEL|LOG_STDERR_LEVEL|logs/runtime|jsonl|retention|7-day|seven" "$AUDIT_TREE" > "$AUDIT_DIR/reports/runtime-logging-hits.raw.txt" || true
```

Record:

- Runtime JSONL payload shape.
- Filename pattern.
- Retention behavior.
- Default location.
- Whether payloads can include prompts, article text, provider responses, API keys, tokens, local usernames, hostnames, stack paths, or machine identifiers.
- Whether public docs mention runtime logs safely and avoid sample payloads with private data.

5. Confirm ignored-path protection.

```bash
git check-ignore -vn data/.audit-sentinel cache/.audit-sentinel logs/.audit-sentinel tmp/.audit-sentinel .tmp/.audit-sentinel .temp/.audit-sentinel temp/.audit-sentinel test-results/.audit-sentinel coverage/.audit-sentinel out/.audit-sentinel dist/.audit-sentinel desktopBuild/.audit-sentinel desktopArtifacts/.audit-sentinel .desktopBuild/.audit-sentinel .desktopArtifacts/.audit-sentinel .cache/.audit-sentinel .secrets/.audit-sentinel assets/article_pdfs/.audit-sentinel assets/user_uploaded_article_pdfs/.audit-sentinel assets/covidence_2/.audit-sentinel assets/covidence_imports/.audit-sentinel assets/covidence_running/.audit-sentinel assets/covidence_study/.audit-sentinel assets/structured_file_imports/.audit-sentinel backups/.audit-sentinel openalex_snapshot/.audit-sentinel models/.audit-sentinel pgdata/.audit-sentinel init-db/.audit-sentinel node_modules/.audit-sentinel > "$AUDIT_DIR/reports/ignored-path-check.txt" || true
rg -n "data/|cache|logs|tmp/|\\.tmp/|\\.temp/|temp/|test-results/|coverage|out|dist|desktopBuild|desktopArtifacts|\\.desktopBuild|\\.desktopArtifacts|\\.cache|\\.secrets|assets/article_pdfs|assets/user_uploaded_article_pdfs|assets/covidence_|assets/structured_file_imports|backups|openalex_snapshot|models|pgdata|init-db" .gitignore .prettierignore .eslintignore 2>/dev/null > "$AUDIT_DIR/reports/ignore-rule-source-hits.txt" || true
```

The `.audit-sentinel` paths do not need to exist. Treat any `ignored-path-check.txt` line that starts with `::` as a missing ignore rule that blocks release until the ignore rule or the plan scope is corrected.

6. Rewrite unsafe examples.
   - Replace private paths, hostnames, stack roots, cluster names, backup paths, emails, tokens, or dataset names with placeholders.
   - Keep public docs limited to loopback/local defaults and public commands.
   - Do not add `.env` requirements for normal development unless explicitly necessary.

## Remediation Rules

- Real secret in current tree: block release, remove from current tree, rotate/revoke, and rescan.
- Real secret only in private history: rotate/revoke first, then publish from clean mirror or cleaned refs only.
- Private hostname/path in current docs/scripts: rewrite before release.
- Private hostname/path only in unpublished private history: prefer clean mirror with no inherited history.
- Runtime log or fixture with article text, PHI, PDF content, provider payloads, or prompts: remove unless explicitly licensed, scrubbed, and approved.
- Unknown artifact rights: block release until keep/rewrite/remove/move is decided.

## Deliverables

- `$AUDIT_DIR/reports/audit-head.txt`, `$AUDIT_DIR/reports/working-tree-status.txt`, `$AUDIT_DIR/reports/reachable-refs.txt`, `$AUDIT_DIR/reports/origin-refs.txt`, and `$AUDIT_DIR/reports/remotes.txt` kept locally, outside git.
- Tool-version reports for `git`, `rg`, `gitleaks`, and `trufflehog`, kept locally, outside git.
- Local redacted `gitleaks` reports and local raw-or-redacted `trufflehog` JSONL reports, kept outside git.
- A security finding log with redacted evidence and closure status.
- A secret rotation/revocation log for any real credential.
- A config and local-data inventory with keep/rewrite/remove/move decisions.
- A binary and archive artifact inventory with inspection method, redistribution decision, and closure status.
- A logging-surface note covering runtime JSONL env vars, ignored paths, payload shape, filename pattern, and retention behavior.
- Final recommendation for clean mirror, history rewrite, or keeping the current repo private.

## Touched Layers

- docs
- scripts
- git history and release ops
- runtime logging
- local data and generated artifacts
- provider/config storage

## Quality Gates

- `gitleaks` all-history scan runs after `git fetch --all --tags --prune`, covers all reachable refs, and every hit is triaged.
- `trufflehog` all-history scans run after remote refs are refreshed, cover every ref in `reachable-refs.txt` with per-ref reports, and every hit is triaged.
- `working-tree-status.txt` is recorded and empty before creating `$AUDIT_TREE`, so the current-tree scan matches the intended release commit.
- Tool versions are recorded for `git`, `rg`, `gitleaks`, and `trufflehog`.
- Manual `git log -S` and `git log -G` searches cover old API paths, admin/debug route names, private URLs and IPs, private infra strings, runtime log variables, and runtime profile variables across all tracked paths in the scanned refs.
- Manual `rg --hidden --no-ignore` searches cover current-tree secrets, private infra strings, env vars, provider credentials, token storage, runtime logs, fixtures, samples, generated artifacts, publication artifacts, and hidden config.
- Every real secret is rotated or revoked before any public release decision.
- Every current tracked fixture, sample, export, snapshot, PDF, NDJSON, JSONL, log-like artifact, and ignored/generated local data family has a keep/rewrite/remove/move decision or is explicitly excluded from the public snapshot.
- Every tracked binary, archive, office, image, database, or columnar artifact has an inspection method and keep/rewrite/remove/move decision; clean text scans alone are not accepted as coverage.
- Runtime JSONL payload shape, retention behavior, and ignored paths are documented and public-safe.
- Audit reports are written outside the repo, current-tree scanners do not scan their own report output, and `.gitignore` keeps local runtime data out of git.
- `git check-ignore -vn` shows a real ignore source for every protected local-data path and no `::` non-match lines.
- Final public release uses a clean audited snapshot or an explicitly justified, re-scanned history exception.
- For markdown-only changes to this plan, run `bunx prettier --check SEC_AUDIT_PLAN.md`.
