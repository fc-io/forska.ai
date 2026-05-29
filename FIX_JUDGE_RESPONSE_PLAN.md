# Fix Judge Response Handling Plan

## Context

The running API showed `/api/tokens/failed-requests` has a large backlog of failed request telemetry. A recent sample showed most failures were recovered retries, but a small number still became terminal failures.

Recent sample findings:

- Total failed-request rows reported by the API: `607,364`.
- Latest `500` rows were for `cov | GPT 5.5 xhigh | 5` using `codex/gpt-5.5/xhigh`.
- Latest `500` detail records: `494` recovered retries and `6` terminal failures.
- Main recent error classes: nested JSON-in-answer enum failures, Codex turn timeouts, and quote-validation failures.
- Deep pagination with `offset: 5000+` returned a DuckDB out-of-memory `500` from the failed-requests list query.

## Goals

- Reduce avoidable retries and terminal failures caused by provider response shape issues.
- Preserve benchmark-critical provider/model/thinking configuration. Do not silently change model, provider, effort, or request profile.
- Improve post-response recovery only when the response is deterministic and still validates against the prompt contract.
- Make failed-request diagnostics distinguish recovered retries from unrecovered failures.
- Prevent the failed-requests API from doing unbounded or high-memory scans.

## Non-Goals

- Do not silently downgrade models, thinking levels, providers, timeouts, or capacity settings.
- Do not hide provider usage-limit failures by retrying indefinitely.
- Do not increase `DUCKDB_MEMORY_LIMIT` as the primary fix for failed-request pagination.
- Do not remove failure telemetry. Keep enough detail to debug bad responses.

## Fix 1: Recover Nested JSON Stored In `answer`

### Problem

Some Codex structured-output responses match the outer JSON schema but put the entire intended judgment object inside the `answer` string. The outer response then fails ArkType enum validation because `answer` is not one of the expected values.

Before:

```json
{
  "answer": "{\"answer\":\"yes\",\"explanation\":\"The study evaluates a pharmacist intervention.\",\"quotes\":[\"pre-to-post intervention study\"]}",
  "explanation": "",
  "quotes": null
}
```

Current result:

```text
answer must be "maybe", "no" or "yes" (was "{\"answer\":\"yes\", ...}")
```

After:

```json
{
  "answer": "yes",
  "explanation": "The study evaluates a pharmacist intervention.",
  "quotes": ["pre-to-post intervention study"]
}
```

### Proposed Behavior

After parsing JSON and before ArkType validation, detect this specific recoverable shape:

- Parsed value is an object.
- `answer` is a string that parses as a JSON object.
- The parsed inner object has `answer`, `explanation`, and `quotes`.
- The outer `explanation` is empty or missing.
- The outer `quotes` is `null`, empty, or missing.
- The inner object validates against the prompt type.

Only then replace the parsed object with the inner object and continue normal validation and quote validation.

### Implementation Notes

- Implement in `src/agent/judge/parseSinglePromptJudgment.ts`.
- Keep the recovery deterministic. If the inner object does not validate, keep the current failure path.
- Track recovery in token-use failure/success diagnostics only if useful. For success rows, avoid storing full prompts or responses.

### Tests

- Add parser tests for nested JSON-in-answer recovery.
- Add negative tests where `answer` is a normal string, invalid JSON, or valid JSON with the wrong shape.

## Fix 2: Generate Prompt-Specific Output Schemas

### Problem

`getSinglePromptOutputSchema()` currently allows `answer` to be any string or string array. That permits the provider to produce a schema-valid but application-invalid response where `answer` contains a JSON string.

Before:

```ts
answer: {anyOf: [{type: 'string'}, {type: 'array', items: {type: 'string'}}]}
```

Provider can return:

```json
{
  "answer": "{\"answer\":\"no\",\"explanation\":\"...\",\"quotes\":[]}",
  "explanation": "",
  "quotes": null
}
```

After, for `prompt.type = "'yes' | 'no' | 'maybe'"`:

```ts
answer: {enum: ['yes', 'no', 'maybe']}
```

Provider should return:

```json
{
  "answer": "no",
  "explanation": "The article does not evaluate an implemented intervention.",
  "quotes": []
}
```

### Proposed Behavior

Build the output schema from `prompt.type`:

- Enum prompt: use JSON Schema `enum` for `answer`.
- Enum array prompt: use `array` with `items.enum`.
- Open-ended prompt: keep `string` or `string[]` fallback.
- Numeric prompt: use the appropriate number/integer-compatible schema if supported, otherwise keep current fallback and rely on ArkType validation.

### Implementation Notes

- Change `getSinglePromptOutputSchema()` in `src/agent/judge.ts` to accept `prompt.type`.
- Reuse or extract existing prompt-type parsing logic from route utilities instead of creating another incompatible parser.
- Continue to validate with ArkType after parsing. Provider schema constraints are a pre-request guard, not the source of truth.

### Tests

- Unit test schema generation for enum, enum array, open string, and null prompt types.
- Existing judge Codex transport tests should still assert that `outputSchema` is passed through unchanged.

## Fix 3: Treat Codex Usage Limits As Rate-Limited, Not Generic Transient Failures

### Problem

Older sampled rows showed repeated failures like this:

```text
codex app-server: turn failed: You've hit your usage limit. Visit https://chatgpt.com/codex/settings
```

Current behavior groups this under `codex_transient_turn_failure`, which can make the judge retry or requeue work even though the provider is explicitly refusing more work.

Before:

```text
usage limit -> transient prompt failure -> retry/requeue more work
```

After:

```text
usage limit -> rate_limited provider failure -> pause/cooldown and surface operator message
```

### Proposed Behavior

Classify Codex usage-limit messages as rate-limited provider failures:

- Detect phrases such as `usage limit`, `hit your usage limit`, and Codex settings URL failures.
- Convert to a provider failure with `kind: 'rate_limited'`.
- Pause or gate additional requests according to the existing provider admission/cooldown path.
- Surface the message in job health so the operator sees the exact reason.

### Implementation Notes

- Review `src/server/providers/transports/codexAppTransport.ts` and `src/server/cron/judgmentsJobs/connectionHealth.ts`.
- Keep normal turn timeouts as prompt-scoped transient failures unless they indicate app-server initialization or connection failure.
- Do not silently switch to another model/provider.

### Tests

- Add connection-health tests for Codex usage-limit messages.
- Assert usage-limit failures set `shouldPauseConnection: true` and `kind: 'rate_limited'`.
- Assert normal Codex turn timeouts remain prompt-scoped and do not open endpoint cooldown.

## Fix 4: Separate Recovered Retries From Terminal Failures In Diagnostics

### Problem

The failed-requests page lists rows where `has_failed_requests = TRUE`, including rows where the final request later succeeded. This makes the system look worse than it is and hides the smaller set of terminal failures.

Before list row:

```json
{
  "failureType": "retry",
  "attempts": 2,
  "failedAttempts": 1,
  "error": "Invalid quotes: not substrings of record text"
}
```

This appears next to terminal failures with the same visual weight.

After list behavior:

```text
Recovered retries: response eventually succeeded after one or more failed attempts.
Terminal failures: all attempts failed or the queue had to requeue the prompt.
```

### Proposed Behavior

Add API and UI filtering/grouping:

- `failureType = retry`: recovered retry.
- `failureType = total_failure`: terminal failure.
- Default admin view should emphasize terminal failures first.
- Keep a recovered-retry tab or filter for prompt-quality analysis.

### Implementation Notes

- Extend `/api/tokens/failed-requests` body with optional `failureType` or `status` filter.
- Add counts for recovered and terminal failures.
- In the admin route, show explicit labels such as `Recovered Retry` and `Terminal Failure`.

### Tests

- Add failed-request route tests for filtering and counts.
- Add UI query logic tests if existing test setup covers route components.

## Fix 5: Make Final Quote Handling More Forgiving When The Judgment Is Valid

### Problem

Quote validation failures are often not answer failures. A response can have a valid answer and explanation but one quote that is not an exact substring. Today, final invalid quotes can force a terminal failure for `yes` or `maybe` answers.

Before:

```json
{
  "answer": "yes",
  "explanation": "The study evaluates an antibiotic restriction program.",
  "quotes": ["before and after an implementation of an antibiotic-restriction program"]
}
```

If the quote differs slightly from source text, the result can be:

```text
Invalid quotes: not substrings of record text -> retry -> final requeue/terminal failure
```

After, when answer and explanation are valid:

```json
{
  "answer": "yes",
  "explanation": "The study evaluates an antibiotic restriction program.",
  "quotes": []
}
```

Stored diagnostic:

```json
{
  "quoteRepair": "dropped_invalid_final_quotes",
  "invalidQuoteCount": 1
}
```

### Proposed Behavior

Keep current retry behavior for invalid quotes before the final attempt. On the final attempt, if the answer and explanation validate:

- Keep exact-match quotes.
- Drop invalid quotes.
- Store the judgment with the remaining quotes, possibly `[]`.
- Record a lightweight warning in diagnostics rather than failing the whole prompt.

### Tradeoff

This reduces avoidable failures but weakens evidence strictness. It should only apply after retries are exhausted and only when the answer payload is otherwise valid.

### Implementation Notes

- Update `validateSinglePromptJudgmentQuotes()` in `src/agent/judge.ts`.
- Keep stricter behavior available if a project later requires quote evidence as mandatory.
- Preserve the existing auto-repair behavior for `no` answers.

### Tests

- Extend `src/agent/judge/judgeQuoteValidation.test.ts`.
- Add final-attempt tests for `yes`, `maybe`, and `no` with mixed valid/invalid quotes.

## Fix 6: Make Failed-Requests API Memory-Safe

### Problem

The failed-requests list query currently sorts and offsets across many `app.token_use` rows while selecting full `failed_requests_details` JSON. Deep offsets caused DuckDB OOM and returned plaintext DB internals to the client.

Before request:

```http
POST /api/tokens/failed-requests
Content-Type: application/json

{"limit":250,"offset":5000}
```

Before response:

```text
HTTP 500
Out of Memory Error: could not allocate block of size 256.0 KiB ...
```

After request:

```http
POST /api/tokens/failed-requests
Content-Type: application/json

{"limit":100,"cursor":{"createdAt":"2026-05-27T15:31:17.029Z","id":"..."}}
```

After response:

```json
{
  "success": true,
  "data": [
    {
      "id": "judgment-completion-token-use:...",
      "createdAt": "2026-05-27T15:30:00.000Z",
      "failureSummary": {
        "terminalFailures": 0,
        "recoveredRetries": 1,
        "firstError": "answer enum received JSON string"
      }
    }
  ],
  "nextCursor": {"createdAt":"2026-05-27T15:30:00.000Z","id":"judgment-completion-token-use:..."}
}
```

### Proposed Behavior

- Clamp `limit` to a small maximum such as `100` or `250`.
- Replace high-offset pagination with cursor pagination on `(created_at, id)`.
- Return summary fields from the list route, not full `systemPrompt`, `userPrompt`, and `lastResponse` details.
- Keep full failure details available only on `/api/tokens/failed-requests/:id`.
- Add local error handling so DB errors return structured JSON and do not expose raw DuckDB internals.

### Implementation Notes

- Update `src/server/routes/TokensRoutes.ts` validation for list inputs.
- Update `src/server/services/tokenUseQueryService.ts` list query.
- Consider adding a DuckDB migration for an index or projection if cursor pagination alone is not sufficient.
- Do not solve this by raising DuckDB memory limits.

### Tests

- Route tests for clamped limit, cursor pagination, and malformed cursor handling.
- Service tests that list rows omit full failure payloads but detail route still returns them.
- Error-shape tests for failed DB queries if route test setup supports mocking.

## Suggested Implementation Order

1. Add parser recovery for nested JSON-in-answer responses.
2. Add prompt-specific output schemas to prevent the bad shape before the request.
3. Improve Codex usage-limit classification to stop wasteful retries.
4. Add forgiving final quote handling with diagnostics.
5. Split failed-request diagnostics into recovered retries and terminal failures.
6. Rework failed-requests list pagination and error handling.

## Quality Gates

- `bun test src/agent/judge/judgeQuoteValidation.test.ts`
- `bun test src/agent/judge/parseSinglePromptJudgment.test.ts` after adding parser tests
- `bun test src/server/cron/judgmentsJobs/connectionHealth.test.ts`
- `bun test src/server/routes/tokensRoutes/tokensRoutesGetFailedRequests.test.ts`
- `bun test src/server/services/tokenUseQueryService.test.ts`
- `bun run lint`

## Runtime Verification

- Browser/web flow: open `/admin/failed_requests` and confirm terminal vs recovered failures are clearly separated.
- Browser/web flow: open a failed-request detail row and confirm full prompt/response details still load by ID.
- API flow: call `/api/tokens/failed-requests` with a normal page and deep cursor page; confirm no OOM and structured JSON responses.
- Judge flow: run a small job or targeted mock test where a nested JSON-in-answer response is recovered and stored as a normal judgment.
- Desktop flow: no desktop-specific code is expected unless shared admin routing or API origin behavior changes. If shared route or runtime API wiring changes, run `bun run desktop:build`.
