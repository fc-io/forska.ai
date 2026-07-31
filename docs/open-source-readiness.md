# Open-Source Readiness

This is the consolidated open-source readiness note for Forska. It replaces the
older route-surface, Docker/docs, local API, and secret-history plan files.

## Recommendation

Keep the current repository and existing refs private. Publish only from a clean
audited snapshot after current-tree blockers are removed or rewritten and
dedicated secret scanners have run clean.

Do not publish the existing git history as-is.

## Current Blockers

| Area                            | Status                                                                                                                                   | Required action                                                                                       |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Secret scanning                 | Manual `rg`/git audit found no known-format API keys, bearer tokens, or private-key blocks, but dedicated scanners were unavailable.     | Run `gitleaks` and `trufflehog` against current tree and all refs; keep redacted reports outside git. |
| Historical private infra        | Full history contains old remote ops, private infra, sbatch, Docker/compose, backup/sync, SSH, and local path material.                  | Publish from a clean snapshot or filter history and rescan.                                           |
| Current tracked sensitive files | Current tree includes local tool config, sample/research assets, private path examples, and optional remote/GPU telemetry surfaces.      | Remove, rewrite, or explicitly gate before release.                                                   |
| Route surface                   | Several API routes expose files, provider setup, failed requests, runtime internals, debug state, imports/exports, or operator controls. | Classify every method/path before documenting a supported public/local API.                           |
| Assets/data                     | Tracked article PDFs, Covidence samples, FHIR/medical samples, or uploaded article data require licensing and privacy decisions.         | Exclude unless separately approved.                                                                   |

## Local API Contract

Forska may expose a supported loopback API for the UI, desktop app, local LLM
tools, agents, and scripts, but not every mounted route is supported.

Use these categories:

| Category              | Meaning                                                                                                           |
| --------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Supported local API   | Normal product behavior that local clients may use.                                                               |
| Local diagnostics API | Status/observability useful for local operation.                                                                  |
| Sensitive local API   | Product behavior involving files, provider credentials, failed requests, PDFs, exports, imports, or article data. |
| Internal runtime API  | Worker, queue, DuckDB owner, proxy, and background coordination routes.                                           |
| Maintenance/debug API | Repair, rebuild, database snapshot, admin investigation, cleanup, and dangerous one-off tools.                    |
| Remove before release | High-risk, legacy, dead, sensitive, or unclear surface.                                                           |

The supported API manifest should classify method and path patterns, not just
route files. `apiRouteClassification.ts` is useful input but is not the public
support contract by itself.

## Starting Route Decisions

Keep as supported or diagnostic local API after route-level review:

- project CRUD, review views, filters, settings, articles, prompts, data sources,
  imports, human assessment, comparison projects, models, provider models, normal
  judgment job creation/status, runtime readiness, and DuckDB owner diagnostics

Treat as sensitive:

- project export/import data, article PDF upload/fetch/convert paths, provider
  connection setup, failed request content, token/request traces, and local file
  surfaces

Keep internal or developer-only:

- judgment worker claim/complete/heartbeat/runtime/snapshot routes
- provider admission leases
- repair, drain, checkpoint, quarantine, rebuild, terminalize, database snapshot,
  and operator-script routes

Remove or explicitly gate before public release:

- FHIR/EHR patient import surfaces unless separately justified
- legacy aliases and debug/admin routes that are not part of the supported local
  product

## Docker And Docs

Open-source packaging should favor a clean local developer path:

- document Bun install, migrations, local app/server startup, and optional local
  OpenAI-compatible providers
- avoid requiring `.env` for normal local development
- keep secrets out of docs and examples
- keep GPU/remote-provider setup optional and clearly local/private
- do not publish private machine paths, SSH aliases, private IPs, or historical
  infra examples

## Release Gate

Before public release:

```bash
gitleaks detect --source . --no-git --report-format json --report-path <redacted-current-tree-report>
gitleaks detect --source . --log-opts --all --report-format json --report-path <redacted-history-report>
trufflehog git file://$PWD --json > <redacted-trufflehog-report>
```

Then:

1. Triage every scanner hit.
2. Remove or rewrite current-tree sensitive files.
3. Decide clean-snapshot vs history-filter release.
4. Re-run scanners after remediation.
5. Verify the route manifest and supported local API docs match the shipped
   route surface.
