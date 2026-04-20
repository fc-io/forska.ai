# Raise Token Cap Plan

## Goal

- Stop truncated Anthropic judgment JSON without shrinking input budget more than necessary.
- Make output-cap truncation visible in diagnostics instead of surfacing only as generic JSON parse failures.
- Keep the fix small and focused in the judgment path.

## Current Signal

- Recent failed requests against `POST /api/tokens/failed-requests` show many parse failures landing at exactly `2000` completion tokens per failed attempt.
- The current judge path uses one shared `MAX_COMPLETION_TOKENS = 2000` value for both evidence extraction and final judgment generation.
- That same value is also used in prompt-budget math and chunking decisions, so changing it globally changes both output size and input headroom.
- Anthropic transport currently does not expose `stop_reason`, so likely output-cap stops are recorded as generic `Unexpected EOF` or `Unterminated string` failures.

## Core Decision

- Raise the shared judge completion cap globally to `4000`.
- Retune prompt-fit budgeting so the higher output cap does not unnecessarily force earlier chunking.
- Prefer real input-window metadata when the model exposes separate input and output limits.
- Fall back to subtracting the completion reserve only when we have only a generic total context length.

## Why Not Only Raise The Global Cap

- The old `2000` value was doing two jobs at once: request output cap and prompt-fit budgeting.
- Raising only the cap would also shrink prompt headroom in the chunking logic.
- The safe fix is to raise the shared cap and then compute prompt budget from the model's real input window when available.

## Step 1. Raise The Shared Judge Cap

Files:

- `src/agent/judge.ts`
- `src/agent/judge/judgeChunkedMode.test.ts`
- `src/agent/judgeLogging.test.ts`

Changes:

- Raise `MAX_COMPLETION_TOKENS` from `2000` to `4000`.
- Keep both direct judgments and chunked judgments on the same higher cap.
- Update request logging expectations accordingly.

Expected result:

- Truncated final JSON responses stop clustering at the old `2000` output ceiling.

## Step 2. Decouple Prompt Budget From Output Cap

Files:

- `src/server/providers/providerModelMetadata.ts`
- `src/server/providers/providerModelMetadata.test.ts`
- `src/server/cron/judgmentsJobs/judgmentsJobsSendToLLM/processPromptWithLLM.ts`
- `src/server/utils/fulltextProcessing.ts`
- `src/server/utils/fulltextProcessing.test.ts`
- `src/agent/judge.ts`
- `src/agent/judge/judgeChunking.ts`
- `src/agent/judge/judgeChunking.test.ts`

Changes:

- Add a helper that derives prompt-token budget from provider metadata.
- If metadata exposes a real input window, use that directly for prompt-fit checks.
- If metadata exposes only a generic total context length, subtract the completion reserve there.
- Keep fulltext prompt budgeting aligned with the same prompt-budget model so response reserve is not subtracted twice.

Expected result:

- Raising the shared cap does not penalize prompt size on models that expose separate input and output windows.
- Fulltext and chunking decisions stay close to previous behavior instead of shifting earlier across the board.

## Step 3. Optional Prompt Pressure Follow-Up

Files:

- `src/agent/judge/judgeSinglePromptSystemPrompt.ts`
- `src/agent/judge/judgeSinglePromptSystemPromptStructuredImport.ts`
- `src/agent/judge/judgeSinglePromptSystemPromptPatient.ts`
- `src/agent/judge/judgeSinglePromptEvidenceSystemPrompt.ts`
- `src/agent/judge/judgePromptConstants.test.ts`

Changes:

- If truncation remains after Steps 1-2, reduce quote-size pressure in prompts without changing the schema.

Expected result:

- Smaller JSON outputs if the larger cap alone is still not enough.

## Step 4. Diagnostics Follow-Up

Files:

- `src/agent/judge.ts`
- `src/agent/judge/judgeStoreTokenUse.test.ts`

Changes:

- When parse failure happens after a provider max-token stop, record a more specific truncation-facing error message and emit a structured `ERROR` event with `stopReason`, `completionTokens`, and `maxCompletionTokens` attrs.
- Keep existing retry behavior intact for the first pass.

Expected result:

- Failed-request admin data becomes easier to interpret.
- We can confirm whether the new cap materially reduces truncation instead of guessing from generic parse errors.

## Implementation Order

1. Raise the shared judge cap and update tests.
2. Switch prompt-fit budgeting to input-aware metadata and aligned fulltext budgeting.
3. Recheck `POST /api/tokens/failed-requests` on the running server after deployment.
4. Only tighten quote prompts if truncation remains after Steps 1-2.
5. Only add recovery fallback logic if unresolved truncation still remains after Steps 1-4.

## Done Criteria

- Recent Anthropic final-judgment parse failures no longer cluster at exactly `2000` completion tokens per failed attempt.
- Raising the shared cap does not push a meaningful number of prompts into chunked mode just because of prompt-budget bookkeeping.
- Fulltext budget checks and direct prompt-fit checks stay aligned.

## Touched Layers

- server
- docs
- tests

## Quality Gates

- `bun test src/server/providers/transports/anthropicMessagesTransport.test.ts`
- `bun test src/server/providers/providerModelMetadata.test.ts`
- `bun test src/server/utils/fulltextProcessing.test.ts`
- `bun test src/agent/judge/judgeChunkedMode.test.ts`
- `bun test src/agent/judge/judgeChunking.test.ts`
- `bun test src/agent/judge/judgePromptConstants.test.ts`
- `bun test src/agent/judgeLogging.test.ts`
- `bun run lint`
- `bun run build` not required for the planned implementation unless the work expands into app or admin UI changes.

## Commands Reviewed

- `lsof -iTCP -sTCP:LISTEN -n -P`
- `bun -e '...'` against `http://127.0.0.1:3001/api/tokens/failed-requests`
- Obvious implementation commands such as `bun test` and `bun run lint` were not run yet because this file is planning-only.
