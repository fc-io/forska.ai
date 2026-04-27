# Project Import/Export Plan

## Goal

- Let one Forska user export a project and another Forska user import it as a new project without breaking project, article, prompt, model, provider, and judgment relationships.
- Keep the existing CSV-style `Export data` flow untouched and add a separate full-fidelity `Export Project` flow.
- Make import a guided review flow so the receiving user can inspect the package and resolve missing providers or models before any project rows are written.
- Keep the normal browser flow and the desktop flow working with the same API contract.

## Product Decisions

- Add an `Export Project` button in `src/components/main/ProjectsGrid.tsx` immediately next to the existing `Export data` button.
- Add an `Import Project` button in `src/app/routes/+projects/+index.tsx` immediately to the left of `Create Covidence Project`.
- Keep `Export data` mapped to the current `/projects/$id/export` CSV page.
- Make `Import Project` open a dedicated wizard route at `/projects/import` because the import flow needs multiple review and setup steps.
- Make `Export Project` start a package export from the grid in v1: small exports download directly, and large exports create an export session that the grid polls until the package is ready. Do not add an intermediate export page in v1.

## Package Shape

- Export one zip file, for example `my-project-2026-04-17.forska-project.zip`.
- Put a versioned manifest at the root so imports can validate compatibility before any write starts.
- Store the package as plain JSON or NDJSON plus file assets so it is inspectable and diffable.
- Lock manifest and payload field names to camelCase JSON keys. Keep raw DB snake_case names only in SQL and prose, and use explicit serializers for fields such as `originalData`, `sourceMetadata`, `fullTextPdf`, and `deleteGeneration` so export, analyze, and import never mix package keys with column names. When this plan names source columns such as `model_id`, `article_id`, or `original_data`, treat them as source-column references only; package schemas must use package keys such as `sourceModelId`, `articleId`, and `originalData`.
- Apply the same package-boundary redaction contract to all free-form JSON and string fields, including article `originalData`, article `sourceMetadata`, provider `metadataJson`, provider config, URLs, and full-text-derived fields: recursively drop or rewrite secret-like keys, credentials, token-like query parameters, URL fragments, signed URLs, source-machine absolute paths, and local-only runtime paths, then emit structured omission warnings for every rewrite.

### Suggested Contents

- `manifest.json`
- `project.json`
- `providerConnections.json`
- `models.json`
- `prompts.json`
- `projectPrompts.json`
- `importRoutes.json`
- `projectImportRoutes.json`
- `articles.ndjson`
- `articleImportRoutes.ndjson`
- `projectArticles.ndjson`
- `judgments.ndjson`
- `judgmentAssessments.ndjson`
- `humanJudgments.ndjson`
- `humanJudgmentSummaries.ndjson`
- `reviews.ndjson`
- `assetManifest.json` for exported file assets, checksums, byte sizes, and the payload paths or fields that reference each packaged asset
- `assetManifest.entries[]` must include each asset's package path, checksum, byte size, and explicit `references[]` with payload file, source row id, JSON pointer or field path, and reference kind so import can rewrite `fullTextPdf`, `fullTextAssets`, and any asset URLs embedded in `fullTextHtml` deterministically
- `assets/` for any exported local article files that must be rewritten on import

- Keep `project.json` limited to project-scoped settings. Store project prompt links, project route links, article route links, and project article links in their own payload files so link metadata survives round-trip without overloading one document.

### Manifest Fields

- `schemaVersion`; v1 import accepts only explicitly supported schema versions and fails before payload extraction or any database write when the version is unsupported
- `exportedAt`
- `sourceAppVersion`
- `packageFingerprint` as a stable hash over manifest core and payload checksums, excluding volatile timestamps, so re-exports of the same logical package can warn on duplicate re-import
- `project` summary with source id, name, counts, human judgment mode, and current model reference
- `warnings` for omitted secrets, sanitized provider URL credentials or query data, omitted deleted judgments, omitted pending or unanswered human judgment workflow rows, omitted article conversion-runtime fields, local-only config, and unresolved runtime-specific data
- `payloads` with row counts, checksums, and byte sizes for each payload file
- `assets` summary with asset count, total byte size, and the `assetManifest.json` checksum so import can verify detailed asset references before rewriting file-backed content

## Exported Data Scope

### Include

- Project settings from `app.project`, including name, description, current `model_id` source reference, date bounds, content toggles, `human_judgment_mode`, and source archived state as package provenance.
- On import, create the target project as an active new project with a new id and current target timestamps; do not copy source `id`, `created_at`, `updated_at`, or `archived` into the live target row.
- Normalize `human_judgment_mode = NULL` to `prompt` in the package contract and when creating the target project, because current read paths treat null as prompt mode but some mart rollup SQL checks literal `prompt` or `summary`.
- Prompt definitions and project prompt links from `app.prompt` and `app.project_prompt`, including `original_text`, `transformed_text`, `prompt_heading`, `type`, prompt-row archived state, link order, link enabled state, link archived state, and criteria fields (`criteria_disposition`, `criteria_section_key`, and `criteria_section_label`, including the `combined` disposition).
- Project route scope from `app.project_import_route` and referenced `app.import_route` rows.
- Project article links from `app.project_article` only for articles in the exported, date-bounded article set.
- Exported article set as the union of route-scoped articles from `app.project_import_route` joined through `app.article_import_route` and curated article links from `app.project_article`.
- Current project article scope means the exported article set after applying the project's `date_from` and `date_to` bounds to `app.article.article_created_at` for the union of route-scoped and curated articles, using the existing review-path SQL semantics: `(date_from IS NULL OR article_created_at >= date_from)` and `(date_to IS NULL OR article_created_at <= date_to)`. Therefore articles with `NULL article_created_at` are included only when both project date bounds are absent; if either bound is configured, the comparison with `NULL` excludes the article.
- Do not infer export scope from `mart.project_scope_article` alone because that mart stores project membership before date filtering; package export and import analysis must apply the same article date predicates used by review serving and raw review-query fallback paths. Treat judgment-queue raw fallback behavior as a parity risk until its date-bound filtering is verified or patched, and do not use queue output itself as export scope unless it matches the date-bounded review scope.
- Referenced article rows from `app.article` for the exported article set, including source internal id as `sourceId`, article identity fields (`article_id`, DOI, PubMed id, arXiv id, medRxiv id, bioRxiv id), citation metadata, title, summary, authors, article version, article timestamps, and DB-backed fields such as legacy `import_route`, URL, publication status, `content_hash`, `original_data`, `source_metadata`, `full_text`, `full_text_html`, `full_text_pdf`, `full_text_source`, `full_text_original_format`, `full_text_fetched_at`, `full_text_assets`, and `full_text_char_count`. Serialize those article payload fields under the locked camelCase package contract rather than a mix of raw DB column names and query aliases.
- Article route links from `app.article_import_route` for exported articles and exported import routes so route provenance can be reconstructed only when the target route and planned article-route writes are safe to link.
- Active current-review judgments from `app.judgment` where `deleted_at IS NULL`, scoped by current project article scope, enabled exported prompt links, current `model_id`, and content toggles (`use_title`, `use_abstract`, `use_fulltext`, `use_fulltext_no_images`). Include source ids and remappable project references plus `is_answered`, `answered_original`, `answered_original_as_array`, `confidence_original`, `explanation`, `quotes`, `chunking_strategy`, `delete_generation`, `snapshot_project_model_name`, and timestamps. Do not export every row with a matching `project_id` unless it also satisfies that benchmark-critical judgment configuration.
- Linked judgment assessments from `app.judgment_assessment` for exported judgments. Preserve `assessment_is_correct`, `assessment_comment`, and timestamps.
- Project human judgments from `app.judgment_human`, limited to `is_answered = TRUE` rows in current project article scope and exported project prompt links, only when the exported project's normalized human-judgment mode is `prompt`. Preserve `answer`, `comment`, `is_answered`, and timestamps; do not require a non-empty `answer` because optional prompt answers may be null or empty while answered state and comments are still durable review data.
- Project summary human judgments from `app.judgment_human_summary`, limited to non-empty summary answers in current project article scope, only when the exported project's normalized human-judgment mode is `summary`. Preserve `answer`, `origin`, and timestamps.
- Project review state from `app.review`, limited to current project article scope, including `opened`, every reviewed-section boolean, every reviewed-section comment, and timestamps.
- All provider and model descriptors needed by the project row and by exported judgments.

### Do Not Include

- API keys, secret refs, auth tokens, device login state, or any provider secret store values.
- Local Codex login status and local Codex binary paths like `codexBin`.
- Article full-text conversion runtime state in v1: `full_text_conversion_status`, `full_text_conversion_error`, `full_text_conversion_attempts`, `full_text_conversion_model_id`, and `full_text_conversion_metadata`; surface this as an omission warning because it is machine-local pipeline state, not portable package content.
- Runtime-detection cache, worker health, endpoint health, logs, temp files, or machine-local status snapshots.
- `app.judgment_job`, `app.judgment_job_sqlite_health_projection`, `app.judgment_execution_snapshot`, `app.maintenance_work_lease`, `app.token_use`, `app.llm_status`, `app.nvidia_smi`, or any job-runtime artifacts.
- Pending or unanswered human judgment workflow rows in v1; preserve durable answered review signal, not local assessment session state.
- `app.project_mart_refresh_state`, `app.project_mart_refresh_article_state`, `app.project_mart_refresh_article_quarantine`, `app.project_mart_large_rebuild_state`, or any `mart.*` tables.
- Derived review-serving support tables such as `app.project_article_ordinal`, `app.review_answer_dictionary`, and `app.project_review_serving_generation`; rebuild them through the normal mart refresh path after import.
- Soft-deleted judgments in v1; deleted rows stay out of the package.

## Provider And Model Export Rules

- Export provider connections as sanitized dependency descriptors, not as trusted live credentials.
- Include safe fields such as `providerKind`, `label`, `authMode`, `baseURL`, `maxInflightRequests`, and reviewable config values.
- Parse URL-like provider fields before export and never package usernames, passwords, fragments, or token-like query parameters. If a base URL or worker URL cannot be safely sanitized, omit it, add an omission warning, and require the importer to re-enter or confirm it.
- Treat machine-local values such as local base URLs and manual worker URLs as hints that the importer must confirm or edit, not as silent defaults.
- Export models with enough identity to re-link judgments correctly: `remoteModelId`, package/runtime `modelName` if available from safe metadata or derived from `remoteModelId`, `name`, `displayName`, `variant`, package/runtime `version` if available from safe metadata or derived from `variant`, `source`, provider kind, connection reference, enabled state, and a safelisted `metadataJson` provenance subset. `remoteModelId` is nullable in the current schema, so the package must preserve `name` and `modelName` fallback identity rather than relying only on display labels or nonexistent legacy model columns.
- Export the full dependency set for the project model and every model id referenced by the exported judgment payload.
- Reuse the existing provider setup flows during import instead of inventing a separate import-only credential path, but do not patch an existing chosen provider connection through a path that drops hidden persisted config such as archived state or disabled model ids. If import edits an existing connection, the route or wrapper must preserve the full existing config and only change reviewed fields.
- Treat exported provider descriptors as safe prefill only. If the target provider needs an API key or interactive auth, the import flow must still collect that credential or complete that auth step before the dependency is considered resolved.
- Use the normal provider endpoints for dependency setup where possible: `GET /api/provider-connections` for listing and refresh, `POST /api/provider-connections` for connection creation, `PATCH /api/provider-connections/:id` for editing a chosen connection only if the import flow preserves hidden persisted config, `POST /api/provider-auth/:providerKind/begin`, `POST /api/provider-auth/:providerKind/finish`, and `POST /api/provider-connections/:id/test` for connection setup and verification, `GET /api/provider-connections/:id/discovered-models` for candidate review, `POST /api/provider-connections/:id/models` and `POST /api/provider-connections/:id/sync-models` for non-Codex model materialization, and the Codex runtime endpoints `GET /api/models/codex/status`, `POST /api/models/codex/login`, `GET /api/models/codex/login/:jobId`, plus `POST /api/models/ensure` for Codex materialization.
- Even though the current `POST /api/models/ensure` route still supports Anthropic for project-create style flows, package import must not use that Anthropic path because it binds to the first enabled Anthropic connection instead of the user-resolved mapped connection.
- When using `POST /api/provider-connections/:id/models` for non-Codex import materialization, map imported descriptors to the current route body: `remoteModelId`, `displayName`, `variant`, and provider-specific `options` such as `thinking`. Do not assume imported `source`, `metadataJson`, or fallback local names can be written verbatim through that route; preserve those fields as package provenance unless a dedicated import writer is added.
- Treat selectable Anthropic ids returned by `GET /api/models` for thinking variants, such as `anthropic:<model>:<effort>`, as virtual UI ids, not database `app.model.id` values. Because package import must not use the Anthropic branch of `POST /api/models/ensure`, materialize Anthropic variants through the user-mapped provider connection before using the resulting verified database model id in the import plan.

### Codex Special Handling

- Export Codex model descriptors, but never export Codex login state, Codex secrets, or local `codex` executable paths.
- During import, show Codex dependencies as `setup required` until the receiving user confirms or creates the local Codex connection and, when needed, completes the existing status/login flow (`GET /api/models/codex/status`, `POST /api/models/codex/login`, `GET /api/models/codex/login/:jobId`) before model materialization.
- Reuse the existing singleton Codex connection behavior plus the existing Codex status/login and `POST /api/models/ensure` flows to materialize imported Codex models on the target machine.
- When using `POST /api/models/ensure` for Codex, map the imported descriptor into the current route payload shape: `provider: 'codex'`, `(remoteModelId ?? modelName ?? name) -> modelName`, imported `displayName` with fallback to `name` and then `modelName` -> `name`, and `(variant ?? version) -> version`.
- Block final import while any required Codex-backed model is unresolved.

## Identity And Mapping Rules

- Never trust exported database ids as target ids.
- Keep exported ids as `sourceId` values in the package and build explicit old-to-new maps during import.
- Import always creates a new `app.project` row in v1; do not overwrite an existing project.
- Rebuild all project-scoped foreign keys from the mapping tables inside one import transaction.

### Duplicate And Overlap Strategy

- Import never merges into an existing project in v1; each successful import creates a new project.
- During analyze, compute or validate the package fingerprint and compare it with previously completed imports recorded by the app.
- If the fingerprint matches a prior import exactly, show a non-blocking `already imported on this machine` warning with the stored prior imported project name snapshot, id, and timestamp.
- If the package is not an exact duplicate but overlaps existing data, show an overlap summary instead of a duplicate warning: reused article count, new article count, omitted route-link count, omitted article-route-link count, route-scoped article snapshot-link count, and any currently computable post-remap conflicts that would still block commit.
- Exact package duplicate detection is informational and must not reject by itself because users may intentionally create parallel copies. Normal article, project-prompt, provider/model, and post-remap judgment conflict checks still decide whether final commit can proceed, and their blockers must remain visible next to the duplicate warning.
- Idempotent retry detection must use the import session id or durable commit id, not package fingerprint alone, because multiple intentional imports of the same exact package can exist. The package fingerprint is only for duplicate warnings and overlap review.

### Mapping Strategy

- `project`: always create a new target id, keep source project timestamps and archived state in provenance only, and create the imported project as unarchived.
- `prompt`: resolve through the existing immutable-prompt behavior, not a project-local detached prompt table. Recompute the canonical prompt content hash from the imported prompt fields and use the same `getOrCreateImmutablePromptTx` semantics as create, edit, and subproject flows instead of trusting a serialized hash blindly. Reuse an existing `app.prompt` row when the canonical hash matches; otherwise create a new immutable prompt row. If the matched canonical prompt row is archived and the exported `app.prompt.archived` value is `FALSE`, reuse that row and reactivate it so import matches the current create and edit semantics. Always create fresh `app.project_prompt` link rows for the imported project, preserve imported project-link archive and enablement state there, and do not assume target prompt rows are private to the imported project. After canonical prompt remapping, block import if two distinct exported project-prompt links resolve to the same target prompt id because `app.project_prompt` is unique by `(project_id, prompt_id)` and v1 cannot preserve both link metadata rows.
- `import_route`: match by `route` among active target import routes; if a route is missing or inactive on the target, omit the related project/article route links in v1, show it in preview, include it in overlap and post-import warnings, and continue without blocking the import. Do not reactivate target import routes in v1. Do not persist `app.article.import_route` on created rows unless the exported legacy route value resolves to exactly one mapped active target route and the corresponding article-route write is safe after the checks below; when multiple source routes are present or the source legacy route is missing, inactive, ambiguous, or unsafe, leave the legacy field `NULL` on newly created articles. When reusing a target article, never overwrite an existing legacy route with a missing, inactive, ambiguous, or unsafe source route. Preserve omitted source routes only in package/session provenance. Before creating any `app.project_import_route` link, analyze must prove the mapped target route would not expand the imported project beyond the exported article set after id remapping and planned article-route inserts, independent of the imported project's current date bounds. Also compute the date-bounded current-scope comparison for preview parity, but treat any extra route article outside the current date bounds as a future-expansion risk because route links stay dynamic if the user later changes project dates. Analyze must also prove any new `app.article_import_route` rows for that mapped route would not expand the current date-bounded article scope of existing active target projects already linked to that route, and must show any out-of-date-bound existing-project future-expansion risk as a warning. If a matched route would pull in extra target articles, could later pull in extra target articles after date-bound changes, or would push imported articles into unrelated active target projects, omit the project-route link and unsafe article-route writes, then use snapshot `app.project_article` links for the exported route-scoped articles instead.
- `article legacy route`: for reused target articles where `app.article.import_route IS NULL`, fill that legacy field only when the exported legacy route resolves to exactly one mapped active target route and the corresponding article-route write is safe under the same checks as new article-route writes; otherwise leave the target legacy field unchanged.
- `article`: auto-match only when all non-empty exported stable identifiers converge on one target article or on no target article. Resolve and display exact identifiers in priority order: `article_id`, normalized DOI, normalized PubMed id, normalized arXiv id, normalized medRxiv id, and normalized bioRxiv id. Use the existing shared DOI normalization helper and add explicit shared normalization helpers for the remaining identifier families before analyze matching logic is locked so export and import compare the same canonical forms. If no exact match exists, create a new article. If one identifier matches a target row and another exported identifier is missing on that row, reuse the row and fill the missing value during the non-destructive merge; if the target row has a different non-empty value for any exported stable identifier, block as an article conflict. Because only `article_id` is globally unique today, analyze must show the matched identifier type and all exact candidates when secondary identifiers produce multiple matches, and it must also block commit whenever any non-empty exported stable identifier points at a different target row than another exported identifier. Never heuristic auto-link in v1.
- `project_article`: always create a new link row for the imported project for each exported source `app.project_article` link, even when the article row is reused, and set `imported_from_project_id` to `NULL` in v1. Also create snapshot project-article links for exported route-scoped articles whenever a missing, inactive, or unsafe target route prevents creating the equivalent project-route link. If the same target article is both source-curated and route-scope fallback, insert one `app.project_article` row and keep both reasons in the import plan summary. This intentionally differs from clone and Covidence-managed imports and must not imply local source-project ownership or managed re-sync behavior.
- `provider_connection`: match by provider kind plus safe connection fingerprint only when exactly one enabled target connection matches that fingerprint and its saved config would still leave the required imported models selectable. If local-only identity was excluded from the fingerprint, or the safe fingerprint matches multiple target connections, treat the dependency as unresolved and let the user choose an existing connection, or open the import-wizard provider setup wrapper with sanitized fields prefilled and complete any required credential or auth step there.
- `model`: match by mapped provider connection plus `remoteModelId` and `variant` only when exactly one target model on that connection matches and is enabled and selectable. If the exported model has `remoteModelId = NULL`, only auto-match an existing enabled target model on the mapped connection when exact fallback identity fields from the package, such as `modelName`, `name`, `displayName`, `variant`, and `version`, still converge on one row; otherwise keep it unresolved because the current non-Codex create route requires a remote model id. For resolvable non-Codex models with a remote model id, materialize them during import after the user resolves the provider step, using `POST /api/provider-connections/:id/models` for explicit creation and `POST /api/provider-connections/:id/sync-models` only when provider discovery should refresh or materialize catalog-backed rows on that same mapped connection; use `POST /api/models/ensure` only for Codex. After any materialization route returns an existing or created model id, re-query the mapped connection and require the matching `(provider_connection_id, remote_model_id, variant)` identity to resolve to exactly one selectable database model row, including model enabled state, provider enabled state, archived connection config, and disabled model ids. If a route returns an existing disabled, ambiguous, virtual, or otherwise unselectable model id, keep the dependency unresolved and require the user to enable that exact model through the normal model edit flow or choose a different target model before commit.
- `judgment`: create fresh target ids after article, prompt, model, and content-setting remap succeeds. Preserve the exported judgment id only as `sourceId` for assessment remapping and conflict reporting.

### Source Project Provenance Fields

- `project_prompt.origin_project_id`: leave `NULL` in v1 so imported prompt links match the current project create, clone, and subproject semantics. Keep source-package provenance in the manifest, import session summary, transfer history, and post-import warnings instead of encoding it into `project_prompt`.
- `project_article.imported_from_project_id`: leave `NULL` in v1 and keep source-project provenance only in the manifest, import session summary, and post-import warnings. Treat this as an intentional package-import semantic distinct from clone and Covidence-managed flows.

## Article And Asset Rules

- Preserve enough article content for imported judgments and review screens to stay meaningful.
- If an article references local file-backed content such as PDFs or extracted assets, export the actual files into `assets/` and not just the stored path string.
- Before copying any export asset, validate that the persisted source path is a runtime-relative `assets/...` path with no raw absolute path or backslash input, resolves by `realpath` under the runtime asset root, and is a regular non-symlink file. If the path is absolute, outside the runtime asset root, a symlink, missing, unreadable, or otherwise unsafe, fail export or omit-and-warn before manifest finalization.
- Export must not produce manifest asset references for files that were not copied and checksummed. If a referenced runtime asset is missing, unreadable, or fails checksum after copy, either fail the export clearly or omit and rewrite the affected package field with an explicit warning before manifest checksums and the package fingerprint are finalized.
- When omitting an unavailable asset instead of failing export, rewrite the referencing payload field to `null` or remove only that asset reference according to the field schema, add a structured omission warning with the payload path and field name, and compute checksums and the package fingerprint after that rewrite.
- Use field-specific asset rewriters for `fullTextPdf`, `fullTextAssets`, and asset URLs embedded in `fullTextHtml`. Reject analyze or commit if any persisted package-derived article field still contains a temp path, absolute path, source-machine path, source `/api/runtime-asset` URL, or asset reference not declared in `assetManifest.json`.
- On import, validate asset paths and `assetManifest.json` references before extraction, reject absolute paths, backslash traversal, `..` traversal, symlinks, and normalized-path changes, and never commit rows that still point at session-temp paths.
- During analyze, extract assets only into the import-session temp area.
- During analyze, derive an asset-promotion plan after article matching and non-destructive merge decisions are known so commit only promotes files that created or updated rows will actually reference.
- Final asset destinations must live under a package/session-specific prefix such as `assets/project-transfer/<sessionId>/...`, fail if the destination already exists, and never overwrite existing runtime assets.
- Generate final asset suffixes from server-owned asset ids or checksum-based names plus a safe extension inferred from content or validated metadata; do not derive final runtime filenames from raw package filenames. Keep original package filenames only as provenance in the promotion manifest.
- Before the database transaction starts, copy only those validated and still-needed assets from temp into final runtime-owned paths under `assets/...`, rewrite stored paths to those runtime-relative `assets/...` locations, and record every created path for cleanup. This keeps imported files compatible with the existing `/api/runtime-asset` serving contract.
- Persist the asset-promotion manifest before database writes and update it as each final file is copied so failed-session TTL cleanup and startup recovery can remove orphaned promoted files for sessions that never reach `completed`.
- If any asset copy or rewrite fails, abort before any database write starts.
- If the database transaction fails after asset copies succeeded, best-effort delete only the files created for that import session and leave the session failed.
- If an article match already exists on the target, merge non-destructively inside the import transaction: fill missing target fields, do not erase richer target data, and still link the article to the imported project.
- If the non-destructive merge updates any reused article row, mark every project currently referencing those updated articles dirty inside the same transaction, in addition to marking the new imported project dirty.
- Analyze must include a reused-article update plan in the review UI before commit: reused article count, reused articles with field fills, asset promotions that will update reused article content, and existing project ids or counts that will be dirtied because they already reference those article rows.
- Title, year, author, and source-metadata heuristics may help the review UI explain likely matches, but they must not silently auto-link an article in v1.

## Judgment Integrity Rules

- Export and import only active current-review judgments where `deleted_at IS NULL` in v1.
- Import judgments only after article, prompt, and model mappings are fully resolved.
- Rewrite every judgment foreign key to target ids before insert.
- Because imported prompts may reuse existing immutable prompt rows, imported judgments can still collide with existing target judgments after article, prompt, and model remapping.
- Still validate judgment identity after all ids are remapped, and treat the effective uniqueness key as article, prompt, model, content toggles, and `delete_generation`. `deleted_at` controls active export scope but is not part of the DuckDB uniqueness key, so any post-remap collision within the package or against existing target data, including soft-deleted target rows that still occupy the database unique key, must block the import and show a conflict instead of silently merging or reusing a target judgment.
- Preserve answer payloads, explanation, quotes, chunking strategy, and timestamps where safe.
- Because current visible judgments are selected by natural key plus project article and prompt scope, source `project_id` and `snapshot_project_id` may be `NULL` or may not equal the exported project id. Preserve source values only as package provenance.
- Insert imported judgment rows with `project_id` set to the new imported project id.
- Insert imported judgment rows with `snapshot_project_id` set to the new imported project id so the imported project's review and mart queries continue to work.
- Preserve `snapshot_project_model_name` from the imported payload, but prefer the resolved target model label when a safe replacement is available.
- Re-link `app.judgment_assessment` through the new judgment ids, `app.judgment_human` through the new project, prompt, and article ids, and `app.judgment_human_summary` plus `app.review` through the new project and article ids.
- Before commit, validate package-internal duplicates and target conflicts for every unique key the import writes, not only project-prompt and judgment natural keys: non-null `app.article(article_id)`, `app.project_import_route(project_id, import_route_id)`, `app.article_import_route(article_id, import_route_id)`, `app.project_article(project_id, article_id)`, `app.judgment_assessment(judgment_id)`, `app.judgment_human(project_id, article_id, prompt_id)`, `app.judgment_human_summary(project_id, article_id)`, and `app.review(project_id, article_id)`. Malformed packages must fail before insert instead of relying on source DB constraints or target `ON CONFLICT` behavior.

## Import UX

- Do not write the project into the main tables until the final confirmation step.
- Use a server-side import session so large uploads, preview state, and asset extraction do not live only in browser memory.
- Store staged uploads under the runtime-writable root in `tmp/project-transfer/...` so browser/dev mode and desktop mode share one contract. In desktop this lives outside the repo; in browser/dev it uses the current runtime root, which is repo-local today.
- Stream the uploaded `.forska-project.zip` directly to temp storage instead of buffering the whole file in browser or server memory.
- Give each import session a TTL plus cleanup on commit, cancel, expiry, and best-effort startup recovery. Do not add product-level hard package-size caps in v1; fail only when local machine resources are insufficient for the requested import.
- Freeze the analyzed import plan with a plan revision when the session enters `ready_to_commit`. Dependency-resolution and commit mutations must verify the active plan revision so stale browser tabs cannot commit an older dependency mapping or article plan.
- After a session reaches `ready_to_commit`, dependency-resolution mutations must be rejected unless they explicitly reopen the session to `awaiting_resolution`, create a new `planRevision`, and recompute stale-sensitive blockers.
- Treat commit as single-flight and idempotent per import session. A retry after the session reaches `completed` must return the existing imported project id and completion payload from durable session state or transfer history keyed by that import session id instead of creating a second imported project. Never use package fingerprint alone for commit idempotency because users may intentionally import the same package multiple times.
- Use a server-generated `commitId` and an atomic compare-and-set transition from `ready_to_commit` to `committing` with a writer lease or fencing token before asset promotion starts. Stale `committing` recovery must first look up transfer history by import session id before allowing a retry or marking promoted files orphaned.
- Validate zip member paths before extraction and verify checksums as bytes are extracted; reject duplicate normalized paths, checksum mismatches, absolute paths, backslash traversal, `..` traversal, symlinks, and normalized-path changes.
- Before extraction and before asset promotion, estimate required disk usage and fail early with a clear insufficient-storage error if the current machine cannot hold the package safely.
- For very large packages, run extraction, checksum validation, and analyze work as a server-side background job tied to the import session; the UI polls progress instead of waiting on one long request.
- Keep a small-package fast path so modest imports can still analyze inline without extra job orchestration.
- Any import analyze or commit step that mutates session state, writes transfer history, promotes assets, or writes database rows must run on the active DuckDB writer. Follower or API-only servers must not execute those mutating steps. In v1, keep transfer polling on the normal owner-proxied `/api/*` path unless `apiRouteClassification.ts` is explicitly updated to carve out follower-local readonly session reads.

### Import Steps

1. Upload package.
   - Create an import session, then stream the `.forska-project.zip` upload into that session's runtime temp storage.
   - Validate zip structure and `manifest.json`.
   - Extract payload files into the session temp storage.
   - If the package crosses the configured threshold, continue extraction and analyze asynchronously and show progress until the session is ready.
2. Review package.
   - Show project name, source app version, counts for prompts, project prompt links, import routes, project route links, articles, article route links, project article links, judgments, human judgments, human summary judgments, reviews, provider connections, models, and packaged assets.
   - Show explicit warnings for fields that were intentionally not exported.
   - Show exact-duplicate import warnings when the package fingerprint matches a prior completed import on this machine.
3. Resolve providers and models.
   - Auto-match what can be matched safely.
   - Show missing or ambiguous provider connections.
   - Let the user map to an existing connection, or reuse the existing provider form components inside the import wizard with sanitized fields prefilled. If implementation instead navigates to standalone provider pages, add an explicit `returnTo` or session handoff contract before depending on that flow. Launch the existing Codex status/login flow where needed before Codex model materialization.
   - Let the user create missing models from the resolved provider connection.
4. Review import plan.
   - Show which articles will be reused versus newly created, including the reused-article update plan for any missing fields that will be filled, any assets that will be promoted for reused rows, and any existing projects that will be dirtied because those shared article rows are updated.
   - Show which import routes will be linked versus omitted. Missing or inactive routes, route links that would expand the imported project scope, and article-route writes that would expand existing active target projects stay warnings in v1 and do not block commit by themselves.
   - Show which article route links will be created or omitted, plus which source-curated project article links and route-scope fallback snapshot project article links will be created for the imported project.
   - Show the final model mapping for the project and all imported judgments.
   - Show any blocking article-match conflicts, project-prompt remap conflicts, or post-remap judgment conflicts. In v1 these are review-time blockers, not an in-wizard per-row remap tool.
   - Show overlap counts and any prior-import warning again before confirmation.
5. Confirm import.
   - Verify the submitted `planRevision`, revalidate stale-sensitive assumptions, run asset promotion into final runtime-owned paths only after revalidation passes, then run one transaction that creates the project, prompts, links, articles, judgments, human judgments, human summary judgments, reviews, assessments, mart refresh dirty state, and completed transfer-history row keyed by the import session id.
   - For large imports, let the server own the long-running commit work and expose session progress while the transactional write is in flight.
   - Mark the new project dirty inside the same transaction via `getProjectMartRefreshStateService().markProjectsDirtyAtomically({projects: ..., runner: tx})` so the normal mart refresh worker picks it up, following the current create, edit, and clone flows.
   - If reused article rows were updated by non-destructive merge, also call `getProjectMartRefreshStateService().markArticleProjectsDirtyAtomically({articleIds: ..., runner: tx})` so every existing project that references those articles is dirtied in the same transaction.
6. Finish.
   - Navigate to the new project.
   - Show post-import warnings, such as omitted route links, omitted article-route links, or provider/model provenance notes that did not affect the committed mapping.

## Server Design

- Keep the current CSV export logic in `src/server/routes/ProjectExportRoutes.ts` unchanged.
- Add a dedicated project-transfer route module, for example `src/server/routes/ProjectTransferRoutes.ts`, so package export and package import do not bloat the CSV export file.
- Add a service layer under something like `src/server/services/projectTransfer/` for package assembly, session parsing, mapping, and commit logic. Use `Effect.gen` and explicit acquire/release cleanup for non-trivial export, analyze, and commit orchestration; keep pure transforms as plain functions.
- Assemble each export from one consistent DuckDB read transaction or equivalent snapshot so manifest counts, payload rows, and checksums describe the same source state. If asset files change or disappear while being copied, fail or omit-and-warn before finalizing the manifest instead of emitting broken asset references.
- Validate simple HTTP params with Elysia `t` where that matches the existing route style, but validate new project-transfer JSON bodies, manifest files, payload files, and import-plan contracts with ArkType before processing. For the large package upload endpoint, allow a dedicated streaming multipart handler instead of assuming a plain `t.File()` body is sufficient.
- Reuse the existing provider connection and provider auth services during dependency resolution instead of duplicating credential setup logic inside project import.
- Do not blindly reuse `src/server/services/articleImportStoreService.ts` for package-import commit. That helper auto-creates missing `app.import_route` rows, treats legacy `app.article.import_route` as required route input, derives or normalizes DOI and source metadata, does not persist the full package article field set such as `full_text_assets`, and inserts with `ON CONFLICT(article_id) DO NOTHING` instead of the exact-match-plus-merge rules this transfer flow needs.
- Anchor staged uploads, extracted assets, and rewritten file paths to the runtime-writable root with relative POSIX paths that have already passed package path validation. Prefer `resolveRuntimeWritablePath` for untrusted package-derived paths; reserve `resolveRuntimeFilePath` for already-trusted persisted runtime paths because it intentionally accepts absolute paths. Do not assume browser/dev paths live outside the repo root; they live under the current runtime root today.
- Harden `/api/runtime-asset` path normalization while adding imported assets so serving `assets/...` paths rejects raw absolute paths, raw backslashes, backslash traversal, `..` segments, and paths that normalize differently even if a bad path somehow reaches persisted article content.
- Reuse the existing `/api/*` writer-proxy architecture for transfer routes, but make project-transfer uploads streaming-safe. The current `ApiProxyRoutes.ts` proxy path reads request bodies into memory, which conflicts with the large-package upload goal unless those routes bypass that path or the proxy is upgraded to stream upload bodies through to the writer.
- Before implementing Phase 3 uploads, choose one concrete proxy contract: upgrade `ApiProxyRoutes.ts` to stream request bodies to the owner for project-transfer upload routes, or classify upload routes as explicit writer-direct/bypass routes with tests proving followers cannot mutate sessions locally. Do not leave large uploads on the generic buffered proxy path.
- Support threshold-based execution modes: inline for small packages, background session jobs for large export assembly and large import analyze or commit work.
- Treat those thresholds as execution-mode switches only, not as product limits. Packages larger than the inline thresholds must move to background work instead of being rejected just for size.
- Record completed imports in a small transfer-history store with import session id, package fingerprint, source project summary, imported project id, imported project name snapshot, imported at, counts, and the exact completion payload so analyze can warn on exact duplicate packages later and commit retries can reconstruct the correct completion response for the same session without confusing intentional same-package imports.
- Keep the final commit transactional and fail-fast when any required provider or model mapping is unresolved.
- At commit start, revalidate the frozen plan assumptions that can change after analyze: provider connections and models still enabled/selectable, article identifier matches still converge, route-scope safety still holds, and post-remap judgment uniqueness conflicts are still absent. If revalidation fails, do not write project rows; move the session back to an unresolved review state with fresh blockers.
- Commit requests for a session that is already `completed` must return the recorded completion payload without replaying writes. Commit requests while another commit is in flight must join, poll, or reject with the current session state rather than running a second transaction. If session completion state is missing after a crash but a transfer-history row exists for that import session id, reconstruct the completion response from transfer history instead of creating another project.
- If final-path asset promotion succeeds but the database transaction fails, best-effort delete only the promoted files created for that import session before the session is marked failed.
- Transfer session creation plus background export assembly, import analyze, dependency-resolution mutations, transfer-history writes, and import commit execution must be owned by the active DuckDB writer process. Follow the existing writer-proxy behavior for `/api/*` requests instead of inventing a separate leader-discovery path. In v1, keep transfer session creation, polling, commit, and download on the normal owner-proxied path unless `apiRouteClassification.ts` is deliberately updated to allow follower-local readonly session reads or other safe direct responses.

### Logging

- Emit background export assembly, import analyze, and import commit progress as structured `file-only` runtime events with phase, percent, bytes, row counts, and session identifiers.
- Emit warnings and failures such as omitted route links, unresolved provider or model dependencies, invalid zip members, checksum mismatches, and extraction errors as `both` so they stay terminal-visible and also land in JSONL.
- Preserve terminal fail-fast behavior for blocking import failures such as unresolved required provider or model mappings; file logging supplements that path instead of replacing it.

### Suggested API Surface

- These project-transfer endpoints stay on the normal owner-proxied `/api/*` path in v1. Any follower-local polling or download exception requires explicit `apiRouteClassification.ts` changes.
- `POST /api/projects/:id/export-project`
  - inline file response for small packages
  - `202 Accepted` plus export session metadata for large packages
- `GET /api/projects/export/:exportId`
- `GET /api/projects/export/:exportId/download`
- `POST /api/projects/import/analyze`
- `GET /api/projects/import/:sessionId`
- `POST /api/projects/import/:sessionId/resolve-dependencies`
  - body includes the caller's current `planRevision`; stale revisions return the latest session plan without mutating it
- `POST /api/projects/import/:sessionId/commit`
  - body includes the reviewed `planRevision`; stale revisions fail before asset promotion or database writes
- `DELETE /api/projects/import/:sessionId`
- Add proxy tests proving large export download responses stream through the owner proxy without being materialized into memory on follower servers. Upload bodies need explicit streaming or bypass support; download responses must remain streaming-safe too.

## UI Files To Touch

- `src/components/main/ProjectsGrid.tsx`
- `src/app/routes/+projects/+index.tsx`
- new `src/app/routes/+projects/+import.tsx`
- likely new client helpers near `src/app/routes/+admin/+models/providerConnectionsClient.ts`
- keep new export-package state and helper logic out of the already-large `ProjectsGrid.tsx` body when it becomes non-trivial; use a sibling owner folder/helper instead of growing the component further
- extract a small shared provider-model resolution component from `src/app/routes/+projects/+create.tsx` only if the import flow ends up reusing enough of that UI to justify it
- Use Eden plus TanStack Query for normal project-transfer session reads and mutations. Use `fetch` only where upload or download streaming requires it, and keep those calls local to the wizard/export action.
- do not blindly reuse `src/services/ensureSelectableModelId.ts` for non-Codex import resolution because its Anthropic ensure path binds to the first enabled Anthropic connection, not a user-selected mapped connection
- update `src/app/routes/+projects/-+index.vitest.tsx` so `renders project header actions in the expected order` expects `Import Project` immediately before `Create Covidence Project`, with `href: '/projects/import'`

## Phase Checklist

### Phase 1 - Contract And Schemas

- [ ] Lock the manifest schema, payload file list, supported schema-version policy, and explicit exported field set, including article fields, current-review judgment scope, answered human judgment scope, review row scope, and omission warnings.
- [ ] Define import-session state, plan revisions, source-to-target id maps, unresolved dependency statuses, immutable-prompt link rules, asset cleanup rules, and post-remap judgment-conflict reporting.
- [ ] Pick the zip implementation and lock checksum, package fingerprint, path-normalization, threshold, and resource-gate rules before writing route handlers.
- [ ] Define the thresholds that switch export, analyze, and commit work from inline requests to background session jobs.
- [ ] Define the import-session cancel contract for `DELETE /api/projects/import/:sessionId`, including allowed source states, rejection after terminal states, temp cleanup, and writer-only ownership.

#### Phase 1 Spec

- `Checksums and hashing`
  - Use SHA-256 for payload file checksums, asset file checksums, and `packageFingerprint`.
  - Compute manifest `payloads[*].checksum` over the exact file bytes written into the package.
  - Serialize JSON payloads with canonical key ordering and stable formatting.
  - Write NDJSON payload rows in a locked deterministic order, sorted by stable source identifiers before bytes are emitted.
  - Compute `packageFingerprint` from canonical JSON built from: `schemaVersion`, normalized project source summary, sorted payload paths with checksums and row counts, sorted asset-manifest entries with checksums, and omission-warning codes.
  - Exclude `exportedAt`, `sourceAppVersion`, byte sizes, temp ids, and any session-local values from `packageFingerprint` so equivalent re-exports stay stable.

- `Identifier normalization`
  - Reuse the existing shared DOI normalization helper, but lock a comparison form that is trimmed and lower-cased so DOI case differences cannot create false misses.
  - Add shared normalization helpers for PubMed id, arXiv id, medRxiv id, and bioRxiv id before article overlap matching is implemented so analyze and commit use one canonical trimmed comparison definition.
  - Use those same helpers for duplicate and overlap summaries so preview counts match commit behavior.

- `Zip rules`
  - Root entries must be relative POSIX-style paths with `/` separators and no backslashes.
  - Reject archive members that are absolute paths, contain a `..` path segment, normalize to a different path, normalize to the same path as another member, or are symlinks.
  - Reject NUL bytes, overlong path segments, overlong normalized paths, and archive members that collide after Unicode NFC normalization plus case folding, or detect the active temp filesystem's case sensitivity and reject collisions under that filesystem's rules.
  - Require `manifest.json` at the archive root.
  - Allow payload files only from the locked manifest file list plus `assets/**`.
  - Treat manifest-declared sizes and zip directory sizes as untrusted advisory values. Compare them during preflight when available, but enforce authoritative streamed compressed and uncompressed byte counters per entry and for the whole archive, abort on budget or checksum mismatch, and never rely on directory sizes as the only enforcement.

- `Size thresholds`
  - Inline export when estimated package bytes are `<= 128 MB` and estimated asset bytes are `<= 64 MB`.
  - Background export session when either estimate exceeds those thresholds.
  - Inline import analyze when uploaded zip bytes are `<= 128 MB` and preflight estimated uncompressed payload-plus-asset bytes are `<= 512 MB`; if streamed verified bytes exceed the inline threshold during extraction, transition the session to background analyze before analysis continues.
  - Background import analyze when either import threshold is exceeded by upload bytes, preflight estimates, or streamed verified bytes.
  - Background commit when the analyzed plan contains `>= 25,000` articles, `>= 250,000` judgments, or `>= 2 GB` of extracted assets.
  - Do not reject a package only because it exceeds these thresholds. Thresholds switch work from inline requests to background execution.
  - Instead of hard product-size ceilings, gate execution on current machine resources: the runtime temp root must be writable, free temp bytes must be at least uploaded zip bytes plus verified uncompressed bytes plus 10%, free runtime asset bytes must be at least planned promoted asset bytes plus 10%, and background jobs must update progress at least once per configured byte or row interval.
  - Add parser and resource safety gates before extraction and parsing: archive member count or inode availability, maximum normalized path length and segment length, maximum manifest and payload file sizes, maximum NDJSON line size, maximum JSON depth and object member count, streaming parse requirements for large payloads, and a decompression ratio or expanded-byte budget that aborts when actual streamed bytes exceed the verified plan. Treat these as configurable or machine-resource-derived safety ceilings, not product package-size limits.

- `Session storage layout`
  - Store working files under runtime-writable temp paths such as `tmp/project-transfer/import/<sessionId>/` and `tmp/project-transfer/export/<sessionId>/`.
  - These paths are relative to the runtime-writable root. In desktop mode that root is outside the repo; in browser/dev mode it is the current runtime root, which is repo-local today.
  - Import session folders should contain `upload.zip`, `manifest.json`, `extracted/`, `analysis.json`, `plan.json`, `promotionManifest.json`, `completion.json`, and `progress.json`.
  - `plan.json` stores the frozen plan plus `planRevision`; dependency-resolution mutations read the current revision and write a new revision whenever mappings or derived conflicts change. If the session is already `ready_to_commit`, those mutations must first reopen the session to `awaiting_resolution` so no stale ready plan remains committable.
  - `promotionManifest.json` starts empty before promotion and is append-only during asset copy so startup recovery can remove only session-owned promoted files for non-completed sessions.
  - `completion.json` is written after the database transaction commits and stores the imported project id, project name snapshot, completed transfer-history id, package fingerprint, final counts, and post-import warnings needed for idempotent retry responses.
  - The completed transfer-history row is written inside the final database transaction and includes the import session id. If a crash happens after the database transaction commits but before `completion.json` is written, session recovery must reconstruct `completion.json` and mark the session completed from transfer history rather than treating promoted assets as orphaned.
  - Export session folders should contain `build/`, `manifest.json`, `package.zip`, `completion.json`, and `progress.json`.
  - Session metadata should record estimated compressed and extracted bytes as soon as they are knowable. For imports, record compressed bytes from `Content-Length` when available and update extracted-byte estimates after upload and zip-directory or manifest validation, before extraction starts.
  - Export and import session folders both need TTL cleanup on expiry and best-effort startup recovery so abandoned package files do not accumulate.

- `Writer ownership`
  - Transfer session creation and all background export, analyze, dependency-resolution mutation, history-write, asset-promotion, and commit work must run on the active DuckDB writer.
  - Readonly session polling should stay on the owner-proxied `/api/*` path in v1. Follower-local polling is only safe if `apiRouteClassification.ts` is explicitly updated for those paths, and follower servers must never mutate transfer sessions or start background transfer work.
  - Active background export, analyze, and commit jobs must update a durable session heartbeat and owner token. TTL cleanup must atomically transition only stale non-terminal sessions to `expired` or `failed` before deleting files, and startup recovery or cleanup must run only on the active DuckDB writer after checking transfer history and heartbeat staleness.

- `Import session states`
  - `uploading`, `queued`, `extracting`, `analyzing`, `awaiting_resolution`, `ready_to_commit`, `committing`, `completed`, `failed`, `cancelled`, `expired`.
  - `awaiting_resolution` means the package is parsed but still has provider or model dependencies to resolve, or it has blocking article, project-prompt, or judgment conflicts that prevent commit. Article, project-prompt, and judgment conflicts are not remapped in-wizard in v1; expose `canCommit: false` plus a resolution kind such as `requires_new_package_or_target_changes` until the package or target data changes. Missing or inactive import routes stay warnings in v1 and do not keep the session unresolved on their own.
  - `ready_to_commit` means every blocking dependency is resolved, no blocking article, project-prompt, or judgment conflicts remain, and the review plan is frozen for commit.

- `Export session states`
  - `queued`, `assembling`, `packaging`, `ready`, `failed`, `expired`.
  - Small exports may skip persisted session creation and return the file directly.

- `Progress contract`
  - Session responses should expose `phase`, `status`, `planRevision`, `percent`, `bytesProcessed`, `bytesTotal`, `rowCountProcessed`, `rowCountTotal`, `warningCount`, `startedAt`, `updatedAt`, and `expiresAt`.
  - Background phases should be monotonic and resumable enough for UI polling after refresh.

- `Duplicate history store`
  - Add a small app table such as `app.project_transfer_history` with: `id`, `direction`, nullable `session_id`, nullable `commit_id`, `package_fingerprint`, `schema_version`, nullable `source_project_id`, `source_project_name`, nullable `target_project_id`, nullable `target_project_name`, `payload_counts_json`, nullable `completion_payload_json`, and `created_at`. For completed imports, `completion_payload_json` must contain the exact commit response needed to reconstruct `completion.json` after a crash, including final counts and post-import warnings. Export rows may leave it null. Do not require live foreign keys for snapshot fields unless delete behavior is explicitly handled.
  - Lock migration constraints explicitly: `direction NOT NULL CHECK direction IN ('import', 'export')`, `package_fingerprint NOT NULL`, `schema_version NOT NULL`, `created_at NOT NULL`, `session_id NOT NULL` for completed import rows, `target_project_id NOT NULL` for completed import rows, and a unique or effectively unique import lookup on `(direction, session_id)` for non-null import session ids.
  - Enforce a DB-level or repository-level invariant that completed import history rows have non-null `completion_payload_json`, `session_id`, `commit_id`, `target_project_id`, and `target_project_name`; commit retry and crash recovery may reconstruct completion only from rows satisfying that invariant.
  - Add an index on `(direction, package_fingerprint)` so duplicate-import analysis stays cheap, plus any narrow lookup index needed for project-history display.
  - Record one row inside the final successful import transaction with the import session id, commit id, and completion payload, and optionally after each completed export. Direct small exports may leave `session_id` null; completed imports must not.
  - During analyze, match duplicate-import warnings on `direction = 'import'` plus `package_fingerprint`, and use the history row only for warning and display, never for automatic merge behavior. During commit retry or crash recovery, look up completion by `direction = 'import'` plus `session_id`, not by package fingerprint. Export-history rows may support audit or download UX, but they must not produce `already imported` warnings.

- `Overlap summary contract`
  - Session analysis and plan responses should expose `reusedArticleCount`, `newArticleCount`, `reusedArticleUpdateCount`, `reusedArticleFieldFillCount`, `reusedArticleAssetPromotionCount`, `dirtiedExistingProjectCount`, `omittedRouteLinkCount`, `omittedArticleRouteLinkCount`, `routeArticleSnapshotLinkCount`, `duplicateImportMatchCount`, `articleConflictCount`, `projectPromptConflictCount`, and `judgmentConflictCount`.
  - Reused-article update details should list the affected article, field names to be filled, whether an asset promotion is involved, and existing projects that will be dirtied, with large lists summarized after a reasonable UI limit.
  - `judgmentConflictCount` may be `null` while required provider or model mappings are unresolved because target judgment uniqueness cannot be checked until model ids are known. It must be a concrete number before the session can enter `ready_to_commit`.
  - `articleConflictCount` should count blocking stable-identifier conflicts, ambiguous secondary-identifier matches, and distinct exported articles that would collapse to the same target article id.
  - `projectPromptConflictCount` should count distinct exported project-prompt links that canonical prompt remapping would collapse to one target prompt id.
  - `judgmentConflictCount` should count only post-remap judgment insert conflicts that would still block commit. Because prompt rows may be reused through immutable prompt matching, this count can be non-zero even in normal v1 imports.
  - Duplicate-package warnings and overlap summaries are informational; they never silently change the import plan and never override normal blocking conflict checks.
  - `omittedRouteLinkCount` represents missing or inactive target import routes, or matched routes that cannot be safely linked without expanding the imported project scope or an existing active target project scope.
  - `omittedArticleRouteLinkCount` represents exported article-route links skipped because the target route is missing, inactive, because inserting them would expand another active target project's current date-bounded route scope, or because inserting them would create a future-expansion risk for another active target project.
  - `routeArticleSnapshotLinkCount` represents exported route-scoped articles that will be preserved as direct `app.project_article` links because the corresponding project-route link was omitted.

- `Route-scope fidelity contract`
  - A full-fidelity import must not let a reused target import route pull unrelated target articles into the imported project or push imported package articles into unrelated existing active target projects.
  - Analyze must compare the exported route-scoped article set after article id remapping against the target route's current article set plus planned package article-route links without applying the imported project's current `date_from` and `date_to`, before deciding to create an `app.project_import_route` link. Also compute the date-bounded comparison with the same null-bound semantics as current review scope for preview parity, but route-link creation must remain safe if the imported project's date bounds are edited later.
  - Analyze must also compare every planned new article-route link against existing active target projects already linked to that route, using each project's current date bounds against `app.article.article_created_at` with the same null-bound semantics as current review scope, before deciding the article-route insert is safe. If planned writes would not expand current scope but would create a future-expansion risk when existing project date bounds change, show that risk and omit the unsafe article-route write in v1.
  - Omit the project-route link, skip the unsafe article-route writes, preserve the exported articles with snapshot project-article links, and show a warning with the affected route and article counts when any of these conditions holds: the target route is missing or inactive; the target route's current-plus-planned route set would add articles not present in the package; the target route's current-plus-planned route set contains extra articles that are only hidden by current date bounds; planned article-route inserts would expand another active target project's current scope or create a future-expansion risk for another active target project.
  - Existing target article-route links may be reused for provenance. New article-route links may be inserted only when the safety checks prove they do not create cross-project scope side effects; they must not be treated as enough to preserve project membership unless the project-route link is also safe to create.

- `Provider/model resolution contract`
  - Auto-match only when an imported dependency converges to exactly one enabled provider connection or exactly one enabled/selectable model.
  - Define the provider connection fingerprint from normalized provider kind, auth mode, max inflight requests, sanitized config fields that affect model selectability, and effective base URL only when that URL is not machine-local and contains no credentials or token-like query data. Exclude secret refs, secret presence, health-check state, runtime detection cache, machine-local base URLs, credential-bearing URLs, and machine-local worker URLs from automatic matching unless the user explicitly confirms those local hints during resolution.
  - When creating or editing a target connection from a sanitized imported descriptor, providers that require an API key or managed auth may prefill safe fields, but the dependency stays unresolved until the user supplies the key or completes the auth flow.
  - When editing an existing target connection, preserve hidden persisted config values that the current generic provider PATCH body does not expose, including archived state and disabled model ids. If that preservation is not implemented, only let the import flow create a new connection or ask the user to edit the existing connection through the normal provider UI before returning to the wizard.
  - Use `GET /api/provider-connections/:id/discovered-models` when the review UI needs to show provider-discovered candidates before creation.
  - For non-Codex imports, create missing models through `POST /api/provider-connections/:id/models` with the current route body (`remoteModelId`, `displayName`, `variant`, and provider-specific `options` such as `thinking`) and use `POST /api/provider-connections/:id/sync-models` only as a helper when provider discovery is useful for the same mapped connection.
  - Because the current model materialization routes can return an existing model id without proving it is unique or selectable, dependency resolution must immediately re-query the mapped connection and require exactly one matching selectable database model row through the same selectable-model rules used by project create/edit. If the returned model is duplicated by identity, disabled, belongs to a disabled provider, is hidden by archived connection config, is listed in disabled model ids, or is only an Anthropic virtual selectable id, keep it unresolved and offer the normal enable/edit, explicit materialization, or substitute-model path instead of treating materialization as success.
  - If an exported model lacks `remoteModelId`, never assume it can be materialized through the current non-Codex create route. Only auto-match an existing enabled model when fallback identity fields from the package, such as `modelName`, `name`, `displayName`, `variant`, and `version`, resolve to one row on the mapped connection; otherwise require the user to choose a substitute target model before commit.
  - Do not reuse the generic `ensureSelectableModelId` client helper for non-Codex import resolution because import must materialize models on the exact mapped provider connection, not whichever enabled connection happens to be first.
  - Use `POST /api/models/ensure` only for Codex, then verify the returned model id is selectable before marking the Codex dependency resolved.

- `Asset commit contract`
  - Analyze may extract files only into session-temp storage.
  - Analyze must freeze an asset-promotion plan after article matching and merge decisions so commit knows exactly which files are still needed.
  - Commit must copy only needed assets to new, import-session-owned, final runtime-owned `assets/...` paths before the database transaction starts.
  - Commit must persist a promotion manifest before database writes and update it as each final asset path is created so cleanup can distinguish session-owned promoted files from pre-existing runtime assets after a crash or failed transaction.
  - Commit must fail before database writes if any final destination already exists or would overwrite an unrelated runtime asset.
  - Persisted rows must reference only final runtime-relative `assets/...` paths, never temp paths or absolute paths.
  - After a successful commit, session cleanup must remove only temp upload/extraction files. Promoted final assets are now project runtime assets and must not be deleted by session TTL cleanup.
  - Runtime asset paths must be normalized and rejected if they are absolute, escape `assets/`, contain `..`, contain raw backslashes, use backslash traversal, or normalize differently from the stored relative POSIX path.
  - If asset copy fails, abort before the database transaction.
  - If the database transaction fails, best-effort delete all final runtime asset files copied for that import session.
  - Startup recovery must first check durable transfer history by import session id. If a completed import history row exists, mark the session completed or reconstruct `completion.json` and never delete promoted final assets for that session. Only promoted assets from sessions with no completed transfer-history row are orphan candidates, and recovery may best-effort delete only paths listed in that session's promotion manifest.

- `Article conflict review`
  - Because DOI, PubMed id, arXiv id, medRxiv id, and bioRxiv id are not unique in the current schema, analyze must return all exact candidates, the matched identifier type, and a blocking conflict whenever more than one target article matches.
  - Auto-match is allowed only when all non-empty exported stable identifiers converge on the same target article row or are absent from the target. Missing identifier values on the matched target row may be filled by the non-destructive merge, but conflicting non-empty target values must block commit.
  - If identifiers disagree across target rows, analyze must block commit and surface the conflict for review instead of guessing.
  - If two distinct exported article rows resolve to the same target article id after stable-identifier matching, analyze must block commit unless they are the same source article already deduplicated by the package article set. V1 should not silently collapse separate source article rows because that can erase separate project links, reviews, human judgments, or judgments after remapping.

- `Provenance semantics`
  - `project_article.imported_from_project_id = NULL` is an intentional package-import semantic and must not trigger clone-style or Covidence-managed resync behavior.

#### Phase 1 Implementation Breakdown

- `Database contract` owner files: the next numbered DuckDB migration, currently `src/db/duckdbMigrations/0048_projectTransferHistory.sql`, plus `src/db/schemaTypes.ts`. Add the duplicate-history table and typed record first so later phases can rely on it, make sure typed judgment rows expose `deleteGeneration`, account for nullable `JudgmentHumanRecord.projectId`, and add project-transfer-specific row types for exported reviews and any rows not fully modeled by current shared schema types.
- `Route shell` owner files: new `src/server/routes/ProjectTransferRoutes.ts`, `src/server/serverMain.ts`, and, if transfer uploads stay on or bypass the standard `/api/*` proxy path, `src/server/routes/ApiProxyRoutes.ts` plus `src/server/routes/apiRouteClassification.ts`. Mount the new route module in `serverMain.ts`, keep upload proxying compatible with large request bodies, and lock the Phase 1 request and response shapes at the server boundary.
- `Upload route contract` owner files: new `src/server/routes/ProjectTransferRoutes.ts` plus whatever local streaming helper it needs. Lock the session-create and analyze response shapes early, but do not force the upload path into a non-streaming `t.File()` pattern if that would break the large-package requirements.
- `Manifest contract` owner files: new `src/server/services/projectTransfer/projectTransferSchemas.ts`, new `src/server/services/projectTransfer/projectTransferManifest.ts`, new `src/server/services/projectTransfer/projectTransferFingerprint.ts`. Centralize manifest fields, omission warnings, checksum rules, and stable fingerprinting.
- `Zip and path rules` owner files: new `src/server/services/projectTransfer/projectTransferZip.ts`, new `src/server/services/projectTransfer/projectTransferPaths.ts`. Own normalized archive member validation, allowed payload paths, runtime-relative asset path validation, and path-safety helpers.
- `Session and history contract` owner files: new `src/server/services/projectTransfer/projectTransferSession.ts`, new `src/server/services/projectTransfer/projectTransferHistoryRepository.ts`. Define session states, progress payloads, temp-layout metadata, and duplicate-history reads and writes.
- `Session recovery contract` owner files: new `src/server/services/projectTransfer/projectTransferSessionRecovery.ts` plus tests. Own startup recovery, TTL cleanup, heartbeat staleness checks, writer-only cleanup, and promoted-asset orphan decisions.
- `Article and judgment data contract` owner files: extend `src/server/services/appQueryServiceCore.ts` or add a project-transfer-specific query helper so export assembly can actually include every locked article field plus the locked camelCase package serializer mapping for fields such as `originalData`, `sourceMetadata`, `fullTextPdf`, and `deleteGeneration`. Export only the active current-review judgment rows matching the project article scope, prompt links, model, and content toggles instead of assuming the current shared full-article or judgment queries already return the package contract. Include explicit judgment answer fields, `deleteGeneration`, remappable project references, linked assessment fields, and timestamps; do not rely on the current shared `JudgmentRecord` shape unless it has been updated to include `deleteGeneration`; exclude `app.judgment_execution_snapshot` and `app.judgment_job_sqlite_health_projection` as job-runtime state.
- `Prompt data contract` owner files: add a project-transfer prompt query helper or extend the existing project prompt reads so export includes `original_text`, `transformed_text`, `prompt_heading`, `type`, prompt-row archived state, and project-link fields: `prompt_order`, `enabled`, `archived`, `criteria_disposition`, `criteria_section_key`, and `criteria_section_label`. Immutable prompt reuse depends on those canonical prompt fields, not just project-link metadata.
- `Runtime asset route hardening` owner files: `src/server/routes/RuntimeAssetsRoutes.ts` and new `src/server/routes/RuntimeAssetsRoutes.test.ts`. Keep `/api/runtime-asset` compatible with valid `assets/...` paths while rejecting traversal, raw backslashes, backslash traversal, normalized-path changes, and absolute paths before resolving through runtime path helpers.
- `Phase 1 tests` owner files: new `src/server/services/projectTransfer/projectTransferManifest.test.ts`, new `src/server/services/projectTransfer/projectTransferPaths.test.ts`, new `src/server/services/projectTransfer/projectTransferSessionRecovery.test.ts`, new `src/server/routes/ProjectTransferRoutes.test.ts`, new `src/server/routes/apiRouteClassification.test.ts` if transfer routes change classification behavior, and existing `src/server/routes/ApiProxyRoutes.test.ts` plus `src/server/routes/ApiProxyRoutes.retry.test.ts` if upload proxy behavior changes. Cover manifest validation, fingerprint stability, zip/path rejection, runtime asset path rejection, route-level contract failures, writer-only recovery/cleanup, and the chosen writer-proxy behavior for transfer uploads.

#### Quality Gates

- [ ] `bun run db:mig`
- [ ] Add and run `bun test src/server/services/projectTransfer/projectTransferManifest.test.ts`
- [ ] Add and run `bun test src/server/services/projectTransfer/projectTransferPaths.test.ts`
- [ ] Add and run `bun test src/server/services/projectTransfer/projectTransferSessionRecovery.test.ts`
- [ ] Add and run `bun test src/server/services/projectTransfer/projectTransferHistoryRepository.test.ts`
- [ ] Add and run `bun test src/server/routes/ProjectTransferRoutes.test.ts`
- [ ] Add and run `bun test src/server/routes/RuntimeAssetsRoutes.test.ts`
- [ ] Add and run `bun test src/server/routes/apiRouteClassification.test.ts` if transfer routes change classification behavior
- [ ] Add and run `bun test src/server/routes/ApiProxyRoutes.test.ts` if transfer routes change upload proxy behavior
- [ ] Add and run `bun test src/server/routes/ApiProxyRoutes.retry.test.ts` if transfer routes change upload proxy retry behavior

### Phase 2 - Export Assembly

- [ ] Build server-side package export assembly from a consistent DuckDB read snapshot with manifest generation, JSON/NDJSON payload writers, active-judgment filtering, package fingerprinting, and sanitized provider/model export.
- [ ] Extend the article export query layer so package assembly can actually export the locked article field set, including the package payload fields `originalData` and `sourceMetadata` backed by `app.article.original_data` and `app.article.source_metadata`, plus the selected full-text fields.
- [ ] Implement package-boundary redaction serializers and omission warnings across article fields, provider fields, URLs, provider metadata/config, and full-text-derived fields before checksums and the package fingerprint are finalized.
- [ ] Collect local article assets, copy and checksum them into `assets/`, and write `assetManifest.json` metadata for safe import-time path rewriting without leaving references to missing or uncopied files.
- [ ] Add `POST /api/projects/:id/export-project`, support inline download for small packages, and add a background export session path for large packages.
- [ ] Emit structured runtime events for export assembly progress, omitted assets, redaction warnings, checksum failures, and package finalization.
- [ ] Wire the new `Export Project` action in `src/components/main/ProjectsGrid.tsx`, including a `preparing download` state when the export runs asynchronously, and add a focused grid action test for the new button placement and async state.

#### Quality Gates

- [ ] Add and run `bun test src/server/routes/ProjectTransferRoutes.test.ts`
- [ ] Add and run `bun test src/server/services/projectTransfer/projectTransferExport.test.ts`
- [ ] Add and run `bun test src/server/services/projectTransfer/projectTransferRedaction.test.ts`
- [ ] Cover missing, unreadable, symlinked, outside-root, and checksum-changing export assets in project-transfer export tests
- [ ] Add and run `bun test src/server/routes/ApiProxyRoutes.test.ts` with coverage proving large export download responses stream through the owner proxy without being materialized into memory on follower servers
- [ ] `bun test src/server/routes/ProjectsRoutes.test.ts`
- [ ] Cover both small inline export responses and large export-session download responses in route/proxy tests
- [ ] Add and run `bun test src/components/main/ProjectsGrid.vitest.tsx`

### Phase 3 - Analyze And Resolve Dependencies

- [ ] Build upload/analyze session endpoints, staged extraction, TTL cleanup, preview summaries, unresolved-warning reporting, and background progress for large packages.
- [ ] Implement `DELETE /api/projects/import/:sessionId` cancellation with writer-owned state transitions, temp cleanup, and rejection for `committing`, `completed`, `failed`, `cancelled`, and `expired` sessions unless the request is an idempotent repeat.
- [ ] Make project-transfer uploads compatible with the existing writer-proxy topology: current `ApiProxyRoutes.ts` calls `request.clone().arrayBuffer()` for proxied non-GET/non-HEAD requests, so a large upload endpoint such as `POST /api/projects/import/analyze` cannot meet the streaming requirement on follower servers unless the proxy is upgraded to stream request bodies or that upload path bypasses the generic proxy and reaches the writer directly. If bypassing or adding follower-local behavior, update `apiRouteClassification.ts` and its tests explicitly.
- [ ] Lock the chosen large-upload proxy contract before implementation: either streamed owner proxying or explicit writer-direct/bypass routing. Add a follower-path test that uploads a large body and proves the request is not handled by the generic full-body `ArrayBuffer` buffering path.
- [ ] Implement provider connection auto-match, existing-connection selection, an import-wizard provider setup wrapper that reuses the current provider form/client helpers without dropping hidden provider config on existing connections, managed-provider auth handoff through the current `begin` and `finish` routes, non-Codex provider-model materialization through provider-connection model routes, exact database-model identity and selectability verification after every materialization route returns an id, Anthropic virtual-id handling, the full Codex status/login/ensure flow, and `planRevision` handling for all dependency-resolution mutations. Add route/query-state handoff only if the flow leaves the wizard for standalone provider pages.
- [ ] Implement conservative article matching, project-prompt remap conflict detection, route-link and article-route side-effect omission review, route-scope fallback snapshot links, and conflict detection before commit.
- [ ] Implement exact duplicate-package detection from package fingerprint plus overlap summaries for partial matches.
- [ ] Expose every overlap summary contract field in analyze/session responses and the import plan UI, including `canCommit` and a resolution kind such as `requires_new_package_or_target_changes` for conflicts that v1 cannot resolve in-wizard.
- [ ] Emit structured runtime events for upload, extraction, checksum validation, analyze progress, dependency-resolution blockers, and cancel cleanup.
- [ ] Build the `/projects/import` wizard for upload, package review, dependency resolution, and final plan review.

#### Quality Gates

- [ ] Add and run `bun test src/server/services/projectTransfer/projectTransferAnalyze.test.ts`
- [ ] Add and run `bun test src/server/routes/ProjectTransferRoutes.test.ts`
- [ ] Add and run `bun test src/server/routes/ApiProxyRoutes.test.ts`
- [ ] Add and run `bun test src/server/routes/ApiProxyRoutes.retry.test.ts`
- [ ] Add and run `bun test src/server/routes/apiRouteClassification.test.ts` if transfer upload, polling, or download routes change classification behavior or add a proxy bypass
- [ ] Add and run `bun test src/server/services/projectTransfer/projectTransferDependencyResolution.test.ts`
- [ ] Add provider resolution coverage proving import-wizard edits to existing provider connections preserve `archived`, `disabledModelIds`, manual worker config, and secret refs, or proving existing-connection edits are forbidden and users must create a new connection or return through the normal provider UI
- [ ] Add `returnTo` or import-session handoff coverage if dependency setup leaves the wizard for standalone provider pages
- [ ] Add and run `bun test src/server/services/projectTransfer/projectTransferDuplicateDetection.test.ts`
- [ ] Add and run `bun test src/app/routes/+projects/-+import.vitest.tsx`
- [ ] `bun test src/app/routes/+projects/-+index.vitest.tsx`
- [ ] `bun run build`

### Phase 4 - Commit And Post-Import Behavior

- [ ] Implement final-path asset promotion plus the final transaction that creates the new active project, immutable prompt rows or links, article rows and links, judgments, human judgments, human summary judgments, reviews, and assessments with remapped ids, plus mart refresh dirty state and the completed transfer-history row.
- [ ] Apply immutable prompt remapping semantics exactly, including reactivating an archived canonical prompt when the exported prompt row was active. Treat any prompt reactivation dirtying or revalidation the same way current create/edit flows do; if current flows treat it as metadata-only, document that in the commit test.
- [ ] Implement a dedicated project-transfer judgment writer instead of the shared append path. It must explicitly write `delete_generation`, `deleted_at` as null or validated package state, `snapshot_project_id`, `snapshot_project_model_name`, timestamps, and imported answer fields, and it must fail on uniqueness conflicts rather than using `ON CONFLICT ... DO NOTHING`.
- [ ] Revalidate the frozen plan at commit time before asset promotion, reject stale `planRevision` commits without writes, write transfer history with the import session id, `commitId`, and completion payload inside the successful transaction, persist `completion.json` after transaction success, and make completed-session commit retries return the recorded imported project for that same session instead of replaying the import.
- [ ] Do not route full-fidelity package articles through `src/server/services/articleImportStoreService.ts`; implement the project-transfer commit writer so it can preserve the locked article field set and omit missing, inactive, or unsafe import route links and legacy route fields with warning instead of auto-creating them.
- [ ] Leave `project_prompt.origin_project_id` and `project_article.imported_from_project_id` null in v1 as intentional package-import semantics, and surface source-package provenance outside those columns.
- [ ] Mark the new project with `getProjectMartRefreshStateService().markProjectsDirtyAtomically({projects: ..., runner: tx})` and any existing projects affected by reused-article field merges with `getProjectMartRefreshStateService().markArticleProjectsDirtyAtomically({articleIds: ..., runner: tx})` as part of the import transaction, navigate to the imported project, and surface post-import warnings for omitted links or non-blocking provider/model provenance notes.
- [ ] Emit structured runtime events for commit progress, asset promotion, transactional success, rollback cleanup, and commit recovery decisions.
- [ ] Add a rollback-path test that promotes assets, forces the database transaction to fail, verifies promoted final assets are best-effort deleted, and verifies session temp files remain governed by failed-session TTL cleanup instead of being treated as committed assets.
- [ ] Add a crash-recovery test that simulates a successful database transaction and transfer-history write before `completion.json` is written, verifies recovery reconstructs completion from the session id, and verifies promoted final assets are not deleted as orphans.

#### Quality Gates

- [ ] Add and run `bun test src/server/services/projectTransfer/projectTransferCommit.test.ts`
- [ ] Add and run `bun test src/server/services/projectTransfer/projectTransferCommitRollback.test.ts`
- [ ] Add and run `bun test src/server/services/projectTransfer/projectTransferCommitRecovery.test.ts`
- [ ] Add commit retry/recovery coverage that reconstructs completion only from transfer-history rows satisfying the completed-import invariants, refuses or repairs incomplete rows safely, covers concurrent commit requests, and covers stale `committing` ownership recovery
- [ ] `bun run db:mig` if commit/history schema or typed DB records changed in this phase
- [ ] `bun test src/server/routes/providerProjectFlow.e2e.test.ts`
- [ ] `bun test src/app/routes/+projects/-+index.vitest.tsx`

### Phase 5 - Browser And Desktop Verification

- [ ] Verify the browser flow for direct download on small exports, background `preparing download` behavior on large exports, upload, dependency resolution, commit, and post-import review screens.
- [ ] Verify the desktop flow for package download, runtime-writable asset extraction, upload, duplicate warnings, and navigation to the imported project.
- [ ] Verify browser and desktop runtime asset extraction and promotion paths, plus upload and download behavior, because desktop runtime paths live outside the repo while browser/dev paths live under the runtime root.
- [ ] Run the repo-native build and lint checks for touched layers without fixing unrelated issues.

#### Quality Gates

- [ ] `bun run build`
- [ ] `bun run lint`
- [ ] `bun run desktop:build`

## Risks And Decisions To Lock Early

- Article matching stays exact-identifier-only in v1; heuristics can explain likely matches in review but cannot silently auto-link.
- Immutable prompt reuse means cross-project judgment collisions can still happen in v1 after article, prompt, and model remap, so conflict detection must stay strict and must still preserve `delete_generation` as part of the full DuckDB uniqueness key.
- Imported prompt links and imported project-article links will leave `origin_project_id` and `imported_from_project_id` null in v1. Source-package provenance lives in the manifest, import session summary, transfer history, and post-import warnings instead.
- Generic provider model materialization must use provider-connection model routes; project transfer must use `POST /api/models/ensure` only for Codex, even though the existing route still also supports Anthropic for other flows.
- Local provider URLs and worker URLs are transferable only as review hints, not as trustworthy defaults.
- Large project packages need tuned thresholds for switching from inline requests to background jobs so the small-package UX stays fast without risking timeouts or memory spikes.
- Large upload support depends on the writer-proxy path. If project-transfer uploads keep using the generic `/api/*` proxy, `ApiProxyRoutes.ts` must stop buffering request bodies into an `ArrayBuffer`, or transfer uploads must be routed straight to the writer.
- Asset promotion must be driven by the final analyzed merge plan; otherwise reused target articles can leave behind successfully copied but unreferenced files.
- Missing or inactive import routes and target routes that would expand project scope will be omitted with warning in v1, with exported route-scoped articles preserved through direct snapshot project-article links.
- New article-route writes against shared target routes must not expand unrelated existing projects; unsafe writes are omitted with warning and covered by snapshot links on the imported project instead.
- Non-destructive article merges can update rows used by other projects, so commit must dirty every affected existing project, not only the newly imported project.
- Large project packages should be accepted as long as the current machine has enough resources; thresholds exist only to move work into background jobs.
- Package fingerprint semantics must stay stable across equivalent re-exports while still distinguishing meaningful content changes.
- Asset rewrite logic must work in browser mode and desktop mode while always using runtime-owned paths. In desktop those paths live outside the repo; in browser/dev they live under the current runtime root.

## Done Criteria

- A user can export a project from the projects grid with a new `Export Project` action.
- A receiving user can start import from a new `Import Project` action on the projects index page.
- The import wizard shows a clear review step before any write.
- Very large package export and analyze flows switch to server-side progress-aware jobs instead of buffering everything into one request.
- Missing providers and models can be resolved during import: non-Codex through provider-connection model flows, Codex through the existing Codex status/login setup plus `POST /api/models/ensure`.
- API keys, Codex login state, and other secrets are never exported.
- Exact duplicate package imports warn before confirmation, and overlapping imports show clear reuse-versus-create counts.
- Import never expands the new project's article scope with unrelated target-route articles, and never expands unrelated existing projects through shared route writes; missing, inactive, or unsafe route and article-route links are omitted and represented as snapshot project-article links with warnings.
- Imported prompts, articles, judgments, human judgments, human summary judgments, reviews, and assessments all point to correct target ids after import.
- The imported project renders correctly in review flows after mart refresh.
- The browser flow still works, and the shared desktop flow still works.

## Quality Gates

- `bun test src/server/routes/ProjectsRoutes.test.ts`
- Add and run `bun test src/server/routes/ProjectTransferRoutes.test.ts`
- Add and run `bun test src/server/routes/RuntimeAssetsRoutes.test.ts`
- Add and run `bun test src/server/services/projectTransfer/projectTransferManifest.test.ts`
- Add and run `bun test src/server/services/projectTransfer/projectTransferPaths.test.ts`
- Add and run `bun test src/server/services/projectTransfer/projectTransferSessionRecovery.test.ts`
- Add and run `bun test src/server/services/projectTransfer/projectTransferHistoryRepository.test.ts`
- Add and run `bun test src/server/services/projectTransfer/projectTransferExport.test.ts`
- Add and run `bun test src/server/services/projectTransfer/projectTransferRedaction.test.ts`
- Add and run `bun test src/server/services/projectTransfer/projectTransferAnalyze.test.ts`
- Add and run `bun test src/server/routes/ApiProxyRoutes.test.ts`
- Add and run `bun test src/server/routes/ApiProxyRoutes.retry.test.ts`
- Add and run `bun test src/server/routes/apiRouteClassification.test.ts` if transfer routes change classification behavior
- Add and run `bun test src/server/services/projectTransfer/projectTransferDependencyResolution.test.ts`
- Add and run `bun test src/server/services/projectTransfer/projectTransferDuplicateDetection.test.ts`
- Add and run `bun test src/server/services/projectTransfer/projectTransferCommit.test.ts`
- Add and run `bun test src/server/services/projectTransfer/projectTransferCommitRollback.test.ts`
- Add and run `bun test src/server/services/projectTransfer/projectTransferCommitRecovery.test.ts`
- `bun test src/server/routes/providerProjectFlow.e2e.test.ts`
- `bun test src/app/routes/+projects/-+index.vitest.tsx`
- Add and run `bun test src/components/main/ProjectsGrid.vitest.tsx`
- Add and run `bun test src/app/routes/+projects/-+import.vitest.tsx`
- `bun run db:mig`
- `bun run build`
- `bun run lint`
- `bun run desktop:build`
- Browser verify: export a project package, import it through `/projects/import`, and confirm the imported project shows the expected prompts, articles, judgments, and reviews.
- Desktop verify: export and import the same package in the desktop build and confirm file picking, upload, and post-import project navigation work.
