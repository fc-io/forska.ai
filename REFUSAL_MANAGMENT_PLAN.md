# Refusal Management Plan

## Goal

Build an admin-facing refusal review and experimentation workflow for Anthropic safety refusals, so we can:

1. List refusal-prone article + prompt combinations.
2. Inspect the exact prompts and errors that were sent.
3. See which system-prompt variant/version was used.
4. Compare repeated refusals for the same article + prompt pair over time.
5. Edit or select a system prompt and replay the exact request safely.
6. Record outcomes so prompt changes can be evaluated systematically.

This plan is intentionally broader than a simple list page. The objective is to turn refusal debugging into an operational workflow rather than one-off log reading.

## Current State

### What already exists

1. `app.token_use.failed_requests_details` already persists rich failure details for failed request rows.

This includes, at least for many failures:

- `articleId`
- `promptIds`
- `error`
- `failureType`
- `systemPrompt`
- `userPrompt`
- `lastResponse`
- provider diagnostics in some cases

2. The admin UI already has:

- `/admin/failed_requests`
- `/admin/failed_requests/$id`

These pages are useful for individual failed token rows, but they are not refusal-management pages.

3. The job detail page now shows refusal metrics.

This is useful for detection but not investigation.

### What is missing

1. No page groups failures by `articleId + promptId`.
2. No page focuses specifically on Anthropic safety refusals.
3. No durable concept of a system prompt version or last-updated timestamp.
4. No replay / sandbox test flow for the exact failing request.
5. No audit trail for prompt experiments and outcomes.
6. No way to correlate refusal rate with prompt version, provider, model version, or article characteristics.

## Product Requirements

### Required user-facing workflow

1. Add an admin menu entry for refusal management.

Recommended label:

- `Safety Refusals`

2. Provide a list page of refusal-prone article + prompt combinations.

Each row should show at minimum:

- article title
- article id
- prompt heading
- prompt id
- refusal count
- first refusal timestamp
- latest refusal timestamp
- model name
- model provider
- thinking/version label
- system prompt version or system prompt last updated timestamp
- latest refusal status/result

3. Allow clicking into a refusal combination detail page.

The detail page should show:

- article metadata
- prompt metadata
- latest system prompt used
- latest user prompt used
- refusal history for this exact article + prompt combination
- links to other refusal rows for the same article
- links to all other failures, not just refusals, for the same article + prompt pair

4. Allow reviewing all refusal attempts for the same article + prompt pair.

This should include:

- timestamp
- token row id
- job id
- error string
- failure type
- provider diagnostics
- last response
- system prompt snapshot or reference
- user prompt snapshot

5. Allow prompt experimentation.

From the refusal detail page, an admin should be able to:

- choose a system prompt version or custom draft
- reuse the stored user prompt from a refusal
- send the request again against the same provider/model path
- see the raw response, parsed response, refusal/error, and provider diagnostics
- save notes about the result

6. Keep the experimentation path safe and explicitly manual.

This should not mutate production prompt behavior automatically.

## Suggested Information Architecture

### New admin pages

1. `/admin/safety-refusals`

Purpose:

- top-level refusal list
- filtering and sorting
- triage queue

2. `/admin/safety-refusals/$refusalKey`

Purpose:

- deep dive into one article + prompt combination
- full history
- prompt snapshots / versions
- replay and experimentation

3. Optional later page: `/admin/safety-refusals/prompts`

Purpose:

- manage refusal-specific system prompt versions
- compare outcomes by version

## Data Model Plan

### Phase 1: use existing persisted details where possible

We already store `systemPrompt` and `userPrompt` inside `failed_requests_details` snapshots. That is enough to ship a first refusal-review flow.

However, it is not enough for reliable prompt-version tracking.

Problems with using only stored prompt text:

- no stable version id
- no author / note / created-at metadata
- hard to compare prompt variants
- hard to query “which prompt version caused fewer refusals?”

### Phase 2: add first-class prompt version tracking

Add a new database table for article-screening system prompt versions.

Recommended table:

- `app.system_prompt_version`

Recommended columns:

- `id`
- `created_at`
- `updated_at`
- `scope` (`article_judge`, `article_evidence`, later maybe other scopes)
- `provider` (`anthropic`, `all`, etc.)
- `name`
- `description`
- `prompt_text`
- `is_active`
- `supersedes_id`
- `created_by`
- `notes`

Recommended companion table for replay experiments:

- `app.refusal_replay_run`

Columns:

- `id`
- `created_at`
- `article_id`
- `prompt_id`
- `judgment_job_id`
- `model_id`
- `provider_connection_id`
- `system_prompt_version_id` nullable if using ad hoc draft
- `system_prompt_text`
- `user_prompt_text`
- `response_text`
- `parsed_response_json`
- `error`
- `provider_diagnostics_json`
- `stop_reason`
- `status` (`success`, `refusal`, `parse_error`, `transport_error`)
- `operator_note`

### Phase 3: optional derived refusal fact table

If refusal review gets slow or query-heavy, add a derived table like:

- `app.refusal_event`

Each row would represent one refusal detail extracted from `token_use`.

This is optional. Start with query-on-read if performance is acceptable.

## Query / API Plan

### Refusal classification rules

Define one shared refusal classifier on the server.

For now, classify as a safety refusal when:

- provider is Anthropic
- failure code or error indicates `anthropic_empty_response`
- stop reason is `refusal` in the error or provider diagnostics

The classifier should be centralized so:

- job metrics
- failed request pages
- refusal pages
- replay results

all agree on the same definition.

### New backend routes

#### 1. List refusal combinations

Recommended route:

- `GET /api/refusals`

Supports filters:

- `provider`
- `projectId`
- `jobId`
- `promptId`
- `articleId`
- `startDate`
- `endDate`
- `onlyActivePromptVersion`
- `limit`
- `offset`
- `sort`

Response should be grouped by:

- `articleId + promptId + modelId + systemPromptVersionId or prompt hash`

Return:

- article title
- prompt heading
- refusal count
- first/latest refusal timestamps
- latest error
- latest job id
- model/provider/version
- system prompt version label or fallback hash

#### 2. Get one refusal combination detail

Recommended route:

- `GET /api/refusals/:refusalKey`

Return:

- article metadata
- prompt metadata
- refusal timeline
- other non-refusal failures for same article + prompt
- system prompt info
- stored latest `systemPrompt`
- stored latest `userPrompt`
- aggregated counts

#### 3. List system prompt versions

Recommended route:

- `GET /api/system-prompt-versions`

Filters:

- `scope`
- `provider`
- `activeOnly`

#### 4. Create/update system prompt version

Recommended routes:

- `POST /api/system-prompt-versions`
- `PATCH /api/system-prompt-versions/:id`

Use immutable versioning by default.
Editing active prompts should create a new version unless the workflow explicitly supports drafts.

#### 5. Replay refusal with chosen prompt

Recommended route:

- `POST /api/refusals/:refusalKey/replay`

Request body:

- `systemPromptVersionId` or `systemPromptText`
- optional model override
- optional provider connection override
- `dryRun` flag if needed later

Response:

- raw response
- parsed response if valid
- stop reason
- provider diagnostics
- token usage
- status classification

#### 6. Optional compare route

Recommended route:

- `POST /api/refusals/:refusalKey/compare-system-prompts`

Purpose:

- run the same stored user prompt against multiple prompt versions and compare outcomes

This is likely phase 2 or 3, not phase 1.

## UI Plan

### Page 1: Safety Refusals list

#### Purpose

Give a high-signal triage list of the refusal-prone article + prompt combinations.

#### Columns

- article title
- article id
- prompt heading
- prompt id
- refusal count
- latest refusal time
- latest job
- model/version
- system prompt label
- prompt last updated
- latest status badge
- quick link to failed request detail

#### Filters

- provider
- model
- project
- prompt heading
- article title search
- date range
- system prompt version
- `only with repeated refusals`
- `only without successful replay`

#### Helpful derived badges

- `Repeated refusal`
- `Other failures too`
- `Prompt changed since first refusal`
- `No replay yet`
- `Resolved after replay`

### Page 2: Refusal combination detail

#### Sections

1. Summary

- article title
- article id
- prompt heading
- prompt id
- refusal count
- first/latest refusal
- project and latest job links

2. Article preview

- title
- summary preview
- fulltext presence
- article link to project/review pages

3. Prompt metadata

- prompt heading
- prompt text
- prompt type
- associated system prompt version or system prompt hash
- system prompt last updated

4. Latest exact prompt payload

- latest `systemPrompt`
- latest `userPrompt`
- copy buttons
- diff against current active system prompt if available

5. Refusal history table

- timestamp
- token row id
- job id
- system prompt version
- error
- stop reason
- failure type
- response preview
- link to full failed request row

6. Other errors for this article + prompt

- parse errors
- quote validation errors
- other provider failures

7. Replay workbench

- choose system prompt version
- or edit custom draft
- reuse stored user prompt
- send test request
- inspect result inline

8. Notes / operator observations

- freeform notes
- recommended next action

## Replay / Experiment Workbench Plan

### Why this matters

Without replay, we only know a refusal happened. We cannot quickly answer:

- did the prompt change fix it?
- is the refusal deterministic?
- does a narrower system prompt help?
- did the response parse but still fail quotes?

### Required behavior

1. Use the exact stored `userPrompt` from the selected refusal.
2. Allow selecting an active system prompt version.
3. Allow editing a draft custom system prompt inline.
4. Send one manual test request only on explicit click.
5. Store the result as a replay run for later comparison.

### Result panel should show

- request model/provider/version
- system prompt version or custom draft
- raw response text
- parsed JSON if valid
- stop reason
- provider diagnostics
- token usage
- refusal classification
- quote validation outcome if run through parser/validator

### Important design choice

For the workbench, support two modes:

1. `Provider raw replay`

- just sends `systemPrompt + userPrompt`
- fastest way to reproduce refusal behavior

2. `Judge pipeline replay`

- runs through parsing and quote validation too
- better for understanding whether a prompt solved refusal but introduced parse/quote regressions

Phase 1 can ship with `Provider raw replay` only.

## Prompt Versioning Plan

### Recommendation

Yes, add system prompts to the database.

Reason:

- the user specifically wants to know which system prompt was used
- “last updated” and “kind” are difficult to infer from raw prompt text alone
- experimentation requires version identity and history

### Recommended versioning rules

1. Prompt versions are append-only by default.
2. One active version per `(scope, provider)`.
3. Stored refusal snapshots still keep raw `systemPrompt` text for historical accuracy.
4. New runs should also store a `systemPromptVersionId` when known.

### Transitional strategy

For older refusal rows that predate versioning:

- show `system prompt label: legacy snapshot`
- compute a stable prompt hash from stored text
- if the stored text matches a known version exactly, backfill the version id lazily in the UI or with a migration job later

## Other Useful Things To Review

The refusal page should also surface related signals that help explain or prioritize failures:

1. Whether the article also succeeds on other providers.
2. Whether the same article fails on all prompts or only some prompts.
3. Whether a refusal is new after a prompt change.
4. Whether refusal rate correlates with language, fulltext presence, or HTML/noisy markup.
5. Whether the article contains likely bio-trigger terms:
   - `virulence`
   - `plasmid`
   - `resistance`
   - `outbreak`
   - `NDM-1`
   - named pathogens
6. Whether the failure only occurs with title + abstract, or also with fulltext.
7. Whether other error modes occur after refusal is fixed:
   - invalid JSON
   - quote validation failure
   - truncated response
8. Whether refusal behavior changes by Anthropic model version.
9. Whether the request was inline retry, queue retry, or clean run.
10. Whether the last successful replay happened under a different system prompt version.

## Suggested Implementation Phases

### Phase 1: Refusal review MVP

Ship:

- admin menu link
- refusal list page
- refusal detail page
- grouping by article + prompt
- latest stored system prompt and user prompt
- refusal history
- links back to failed request rows

Use existing `failed_requests_details` snapshots only.

Do not ship yet:

- prompt editing
- replay
- prompt version DB tables

### Phase 2: Prompt versioning and richer metadata

Ship:

- `system_prompt_version` table
- active version selection for Anthropic article prompts
- version label in refusal list/detail pages
- “last updated” / author / note metadata

### Phase 3: Replay workbench

Ship:

- refusal replay route
- custom prompt draft editor
- saved replay runs
- inline result viewer

### Phase 4: Comparison and optimization

Ship:

- compare multiple prompt versions on one refusal
- derived analytics by version / prompt / provider
- “resolved after prompt version X” indicators

## Backend Design Notes

1. Keep refusal classification logic centralized.
2. Avoid putting expensive parsing logic in the frontend.
3. Prefer query routes over loading giant failure blobs into the browser at once.
4. Do not mutate historical refusal snapshots when prompt versions change.
5. For replay routes, keep writes explicit and auditable.
6. Rate-limit or permission-gate replay if needed later.

## Risks

1. Replay requests can generate real provider spend.
2. Prompt experiments can accidentally drift from production behavior.
3. Historical refusal rows may not map cleanly to prompt versions.
4. Large prompt/user prompt blobs can make list pages slow if not paginated well.
5. If refusal classification is too narrow, some relevant rows will be missed.
6. If refusal classification is too broad, the page becomes noisy.

## Open Questions

1. Should replay always use the original model id, or allow switching model/version?
2. Should custom prompt drafts be persisted, or only saved as replay runs?
3. Do we want one active Anthropic refusal-mitigation prompt, or multiple selectable strategies?
4. Should successful replay results be linkable from the refusal list page?
5. Should replay support only title + abstract first, even if the original used fulltext?

## Recommended First Slice

If we want the smallest valuable first delivery, do this:

1. Add `/admin/safety-refusals`.
2. Group by `articleId + promptId` using current refusal classifier.
3. Add `/admin/safety-refusals/$refusalKey`.
4. Show refusal history plus stored `systemPrompt` and `userPrompt`.
5. Add prompt hash / legacy prompt label now.
6. Add DB-backed prompt versioning next.
7. Add replay workbench after that.

This order gives immediate operational value before the heavier prompt-version and replay work is built.

## Quality Gates

Phase 1 gates:

- `bun test src/server/routes/JudgmentsJobsRoutes.test.ts`
- targeted tests for any new refusal routes and UI pages
- `bun run build`
- `bun run desktop:build`
- manual browser verification for:
  - admin menu link
  - refusal list
  - refusal detail drilldown
  - linking back to failed request detail

Phase 2 gates:

- targeted tests for prompt version routes/services
- `bun run db:mig`
- `bun run build`
- `bun run desktop:build`

Phase 3 gates:

- targeted tests for replay route classification
- verify replay uses exact stored `userPrompt`
- verify replay run persistence
- `bun run build`
- `bun run desktop:build`
