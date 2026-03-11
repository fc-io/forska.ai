# CLEAN_PLAN

Goal: remove legacy/unreferenced repo clutter (docs/plans/scripts/HPC artifacts). Prefer move → `docs/archive/` first, then delete.

## 0. Rule

- Treat “used” = referenced in code/docs, or invoked via `package.json` scripts, or linked from `docs/`.
- Anything else: candidate (verify, then archive/delete).

## 1. Remove now (high confidence, 0 refs / obvious junk)

- `mn5-tunnel-debug.txt` (tracked, contents useless)
- `chdb.hpp` (0 refs)
- `example_original_data.json` (0 refs)
- `scripts/createUnexpectedAnswersAdminPage.md` (obsolete; feature exists)

## 2. Plan docs (explicit pass)

| File                       | Status                                                    | Action                                                          |
| -------------------------- | --------------------------------------------------------- | --------------------------------------------------------------- |
| `CLICK_PLAN.md`            | Parquet-first; conflicts w/ current PeerDB; only doc refs | archive/delete; also update/remove any “see CLICK_PLAN.md” refs |
| `DENORM_API_PLAN.md`       | Only referenced by `CLICK_PLAN.md`                        | delete w/ `CLICK_PLAN.md`                                       |
| `DIRECT_TO_WORKER_PLAN.md` | done; no refs                                             | archive/delete                                                  |
| `HTTP2_PLAN.md`            | mostly done; no refs                                      | archive/delete                                                  |
| `LLM_RUNNER_PLAN.md`       | draft; no refs                                            | move to `future/` or delete                                     |
| `MN5_PLAN.md`              | complete; referenced by docs                              | keep (or move to `docs/` + update links)                        |
| `OA_PLAN.md`               | partial; no refs                                          | move to `docs/` or delete if not needed anymore                 |
| `OPENALEX_PLAN.md`         | partial; no refs                                          | move to `docs/` or delete if not needed anymore                 |
| `PDF_PLAN.md`              | mostly done; no refs                                      | archive/delete (or move to `docs/`)                             |
| `PG_CH_STATUS_PLAN.md`     | large; no refs                                            | move to `docs/` (keep only if still used)                       |
| `PROCESS_PDF_PLAN.md`      | implemented; no refs                                      | archive/delete (or move to `docs/`)                             |

## 3. Other docs likely legacy/duplicate (0 refs)

- Unexpected-answers docs: merge into 1 doc under `docs/`, then delete extras:
  - `HOW_TO_INVESTIGATE_UNEXPECTED_ANSWERS.md`
  - `ADMIN_UNEXPECTED_ANSWERS_PAGE.md`
  - `plans/INVESTIGATE_UNEXPECTED_ANSWERS.md` (keep OR delete after merge)
- Parquet-era docs (if Parquet is fully gone): archive/delete
  - `plans/CLICK_VERIFICATION.md`
  - `REMOVE_PARQUET.md`
- Misc (verify first): move to `docs/` or delete if stale
  - `plans/MN5_CONNECTIVITY_OPTIONS.md`
  - `plans/DOCLING_SERVE_ALVIS2.md`
  - `HPC_PROMPT_RPOCESSING.md`
  - `OPTIMIZE_DB.md` (Postgres-era perf notes; may be stale if ClickHouse-first)

## 4. HPC scripts: archive old `.sbatch` variants (0 refs)

- `forska-alvis-with-context.sbatch`
- `remote-hf-vllm.sbatch`
- `test-vllm.sbatch`
- `forska-mn5-sglang_old*.sbatch`
- `forska-mn5-sglang-64k.sbatch`
- `forska-mn5-sglang-old_64_requests.sbatch`

## 5. `scripts/` candidates (0 refs; verify then remove)

- `scripts/backfillJudgmentsDenormalized.ts` (superseded by `backfillJudgmentsDenormalizedFast.ts`)
- `scripts/dbPull.ts` (likely superseded by `dbRemotePull.ts`)
- `scripts/dbRepairJudgmentsIndex.sh` (ts version exists)
- `scripts/benchmarkCuratedArticles.ts` (manual?)
- `scripts/resetPassword.ts` (manual?)
- `scripts/testClickHouseQuery.ts` (manual?)

## 6. `future/` (notes)

- If truly unused: delete `future/` (0 refs) or move out of repo.

## 7. Execution order (min risk)

1. Delete obvious junk (section 1)
2. Move/archive plan/docs (sections 2–3) + update links
3. Archive old sbatch (section 4)
4. Remove unused scripts (section 5)
5. Delete/move `future/` (section 6)

## 8. Verify after each batch

- `bun test`
- `bun run lint`
- `bun run build`
- Smoke: `bun run dev:server` and `bun run dev:app`
