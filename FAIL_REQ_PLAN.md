# FAIL_REQ_PLAN

## Critique

- Good idea. Current page mixes logical prompt failure and failed stages. Chunk retries collapse into generic `retry`.
- Use `singleRequest`, `chunkEvidence`, `finalSynthesis`. `ordinary article` is vague.
- Keep `failedRequests` = logical prompts that never succeeded.
- Keep `requests` = real LLM attempts. Queue plan already moves that direction.
- Do not group by `baseURL`. One stage can retry on worker A then B.
- One `tokenUse` row can contain multiple failed stages. Show stage set + failed-stage count.
- Old rows cannot be classified perfectly. Show `unknown (legacy)`.

## Plan

- Add stage metadata to `JudgeTokenUsageEntry` and `failedRequestsDetails`:
  - `requestKind: 'singleRequest' | 'chunkEvidence' | 'finalSynthesis'`
  - `chunkIndex: number | null`
  - `chunkCount: number | null`
- Populate metadata in `src/agent/judge.ts`:
  - non-chunked path -> `singleRequest`
  - chunk evidence loop -> `chunkEvidence` + chunk position
  - final synthesis loop -> `finalSynthesis`
- Change failed-detail aggregation in `src/agent/judge/judgeStoreTokenUse.ts`:
  - group by article + prompt + model + requestKind + chunkIndex
  - keep `baseURL` as detail data, not grouping key
  - stop collapsing all chunk failures into one article-level detail
  - keep `failureType` (`retry` vs `total_failure`)
  - exclude connection-only groups
  - keep mixed groups if they contain any non-connection failure
- Keep counter semantics explicit:
  - `requests` = real LLM attempts
  - `failedRequests` = logical prompts that never succeeded
  - `failedSubrequests` = failed stages with at least one non-connection failure
- Add derived server fields for list page in `src/server/routes/tokensRoutes/tokensRoutesGetFailedRequests.ts`:
  - `requestKinds`
  - `stageLabels`
  - `failedSubrequests`
- Stage column rule:
  - one stage -> show exact label (`singleRequest`, `chunk 2/7`, `finalSynthesis`)
  - multiple stages -> join labels; use `Mixed` only if truncation is needed
- Update `src/app/routes/+admin/+failed_requests/+index.tsx`:
  - add `Stage` column
  - add `Failed subrequests` column
  - keep logical failure count separate
- Update `src/app/routes/+admin/+failed_requests/+$id/+index.tsx`:
  - show request kind per detail card
  - show chunk position when present
  - sort/group details by stage
- Legacy handling:
  - no migration needed if only extending JSON detail payload
  - old rows render `unknown (legacy)`
- Verify:
  - single-request failure shows `singleRequest`
  - chunk retry-success shows `chunkEvidence` or `finalSynthesis` + `failedSubrequests > 0`
  - same stage retry on worker A then worker B still renders as one stage detail
  - one token row with chunk-evidence + final-synthesis failures shows both stages
  - total request failure still increments `failedRequests`
  - connection-only failures remain excluded unless policy changes
  - mixed connection + parse/schema failure still shows the non-connection stage detail
