# FAIL_REQ_PLAN

## Critique

- Good idea. Current page mixes logical request failure and subrequest failure. Chunk retries show up only as generic `retry`.
- `ordinary article` is vague. Better: `singleRequest`, `chunkEvidence`, `finalSynthesis`.
- Do not overload `failedRequests`. It currently means logical requests that never succeeded. Counting chunk retries there will make the column misleading.
- One `tokenUse` row can contain multiple failed stages. Table should show stage set + subrequest-failure count, not force one type.
- Old rows cannot be classified perfectly. Show `unknown (legacy)` for rows without new metadata.

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
  - group by article + prompt + model + baseURL + requestKind + chunkIndex
  - stop collapsing all chunk failures into one article-level detail
  - keep `failureType` (`retry` vs `total_failure`)
- Keep `failedRequests` semantics as-is.
- Add derived server fields for list page in `src/server/routes/tokensRoutes/tokensRoutesGetFailedRequests.ts`:
  - `requestKinds`
  - `failedSubrequests`
  - readable stage labels like `chunk 2/7`
- Update `src/app/routes/+admin/+failed_requests/+index.tsx`:
  - add `Stage` column
  - add `Failed subrequests` column
  - keep logical failure count separate
  - show `Mixed` if row has multiple stage kinds
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
  - total request failure still increments `failedRequests`
  - connection errors remain excluded unless policy changes
