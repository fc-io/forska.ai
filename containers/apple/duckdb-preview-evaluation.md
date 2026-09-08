# DuckDB 2.0 preview evaluation — 2026-09-08

**Historical evaluation:** the pinned alpha is now distributed through the shared
[platform packages](../../vendor/duckdb/README.md). The trial results below remain
evidence; statements about unchanged dependencies or trial-only configuration
describe the state at the time. The legacy-WAL and upstream correctness caveats
are not erased by packaging the engine.

Scope: native engine compatibility investigation and isolated live dev trial.
Production dependencies, the container image, and the original primary database
were not changed. Trial-only source/configuration was bind-mounted into the test
container.

## Decision

**The pinned preview passes an isolated dev trial with
`legacy_disable_null_type=true`; it is not yet a drop-in dependency upgrade.**
It fixes the checkpoint-memory regression but rejects the preserved legacy WAL
on both macOS ARM64 and Linux ARM64. The user explicitly authorized discarding
that disposable dev data, so the incompatible WAL was removed from the test
copy and the live app gate continued successfully. New preview WAL replay works.
That reset does not fix legacy-WAL compatibility for data-preserving upgrades.

The trial also exposed a binding compatibility issue: the released Node bindings
cannot decode DuckDB 2.0's SQLNULL vectors. The preview's official legacy NULL
setting resolves the tested cases. Normal installs still use their existing
dependencies; the container image still contains the 1.5.5 backport. Distribution
and wider platform validation remain separate work.

## Exact candidate

- Engine: `v2.0.0-alpha40881`, source
  [`816a3eb2d512ce359efb40d9319f6db59788422a`](https://github.com/duckdb/duckdb/commit/816a3eb2d512ce359efb40d9319f6db59788422a).
- Official artifact run: [34220083513](https://github.com/duckdb/duckdb/actions/runs/34220083513).
- Both checkpoint-memory fixes, `929a0e336b2dfdc2653b5c833bd76af189f29c37`
  and `1da80a4a3adef9053fb665864734debf1407a521`, are ancestors of this revision.
- Bindings: unchanged `@duckdb/node-api` / `@duckdb/node-bindings` `1.5.1-r.1`;
  Bun `1.3.13`; Forska checkout `2dc7edbc2`.
- Downloaded native libraries were substituted only in isolated dependency
  copies or a disposable container bind mount. No C++ compilation was needed.

| Official artifact | Artifact ID | Archive SHA-256 |
| --- | --- | --- |
| `duckdb-shared-libs-osx-universal.tar.gz` | `10055768523` | `56be40b79a60539682d9c03448d91db0628c2cbdaea6e5ca4452d9eead31a614` |
| `duckdb-shared-libs-linux-arm64.tar.gz` | `10056798239` | `d133035fda338172e1a61c4e4858c3425a667b79c40ee3f596874e95daf2ff6f` |

The macOS preview download was matched to the immutable artifact ID and digest
above. Linux was downloaded by artifact ID. Do not depend on a moving preview
URL; verify these hashes before using the saved artifacts. CI artifacts can expire.

## Results

| Gate | Result |
| --- | --- |
| Existing binding loads candidate and executes SQL | Pass, macOS ARM64 and Linux ARM64; `PRAGMA version` confirms the exact engine |
| Identical 1.5.1-seeded fragmented fixture, 32 MiB checkpoint | Baseline fails with OOM; macOS preview passes with exact count/sum/marker checks |
| Old → preview → old small-fixture round trip | Pass; old 1.5.1 read-only reopen at 128 MiB |
| Full repository checkpoint regression in Linux / 8 GiB VM | Pass: fresh seed, 32 MiB checkpoint, fresh-process 32 MiB reopen |
| Selected Forska tests on macOS preview | 175 pass, 0 fail across five files; includes real native DB tests and mocked service/route cases |
| Preserved 123 GB DB plus original pending WAL | **Fail before checkpoint**, same replay error on both platforms |
| Already-checkpointed real-DB copy, then preview marker write and full checkpoint | Pass, literal 4 GB DuckDB cap / 8 GiB Linux VM; about 13.3 s including open/write, RSS about 1.80 GB at checkpoint completion |
| Old 1.5.1 reopens that preview-written real-DB copy | Pass; catalog readable and all 399 conflict-resolution rows remain. This is not a full row-by-row integrity comparison |
| Local equivalent of upstream concurrent-index test | Pass once on macOS: 11 connections, 20,000 inserts; grouped and indexed counts both 20,001. Does not clear upstream CI failure |
| Live review API with unconfigured preview | **Fail:** `Invalid vector type: SQLNULL`; reproduced with released bindings 1.5.1-r.1 and 1.5.5-r.4 |
| Preview with `legacy_disable_null_type=true` | Scalar and nested NULL decoding pass; all 175 selected tests pass again |
| New preview WAL replay after removing old test WAL | Pass through the offline rebuild CLI and subsequent live restart; the new WAL was retained |
| Live app at 4 GB owner / 8 GiB VM with compatibility setting | API, owner, and judge ready; Chromium displays 100 real article rows with no page errors or failed API requests |
| Active review-indexing workload | 36 chunks complete in 45.7 s, pending 294 → 258, searchable articles 1,508 → 3,663, failed chunks remain 0 |

## Blocking legacy-WAL behavior

```text
Data Corruption Error: Failure while replaying WAL file ".../forska.duckdb.wal":
WAL cannot contain more than one checkpoint marker
```

The preserved 18,144,016-byte WAL remained byte-identical after both failed
preview opens: SHA-256
`7754e814a0e866043b34a7cbd4bf8e6cb0158073f222bcbe08779255b845e6e7`.
The old 1.5.1 engine opens the same DB/WAL copy read-only successfully; the
previous 1.5.5 backport verification also recovered/checkpointed this evidence.

The immediate rejection is in
[`WriteAheadLogDeserializer::ReplayCheckpoint`](https://github.com/duckdb/duckdb/blob/816a3eb2d512ce359efb40d9319f6db59788422a/src/storage/wal_replay.cpp#L1409):
the preview throws when `checkpoint_position` is already valid. Stable 1.5.5's
corresponding method replaces the stored checkpoint position without that check.
This identifies the rejection path, not a complete explanation of how the old
WAL acquired multiple markers, nor proof that the stricter check is incorrect.
Do not silently remove WAL files or disable this check to make a data-preserving
upgrade appear to pass. For this dev trial only, the user accepted loss of pending
changes and authorized deletion of the 18,144,016-byte WAL from the isolated
`real-db` copy after confirming no process had it open. The original host DB and
the separate preserved evidence were not modified.

## Live dev-trial configuration and progress

The existing binding throws on `SELECT NULL AS x` because the preview now exposes
SQLNULL vectors. The latest released 1.5.5-r.4 binding also fails this probe, so a
binding version bump alone is insufficient. The official engine option
`legacy_disable_null_type=true` restores the pre-2.0 binder behavior and passes
both scalar NULL and `[NULL]` decoding probes.

Only the disposable worktree's `duckdbService.ts` was changed: the option was
added to both branches of `getDuckdbInstanceOptions` and to
`getReadOnlyDuckdbRuntimeOptions`. The file and candidate library were mounted
read-only over the existing image for the trial. Do not add this preview-specific
option unconditionally to the production 1.5.1 configuration. A future packaged
preview must carry the matching configuration, or a binding that supports the new
type, and verify NULL decoding through the actual app routes.

Final readiness checks returned HTTP 200 and `ready=true` on ports 3001, 3002,
and 3003; the loaded native library reported `v2.0.0-alpha40881`. Chromium loaded
100 rows on the review page. For the active project
`de1399de-4d05-49c6-a778-6d45f230eec7`, two API snapshots captured:

| Signal | 18:00:25 UTC | 18:01:11 UTC |
| --- | --- | --- |
| Completed chunks | 91 | 127 |
| Pending chunks | 294 | 258 |
| Failed chunks | 0 | 0 |
| Search-ready articles | 1,508 | 3,663 |
| `lastProgressedAt` | 18:00:25.030 | 18:01:10.569 |

Existing RSS-triggered owner recycling occurred and recovered. A separately
requested project's chunks remained blocked-over-budget, so this is evidence of
one active workload advancing, not a claim that every queue is unblocked.

## Additional release concerns and next gates

The revision's [nightly suite](https://github.com/duckdb/duckdb/actions/runs/34220080691)
is not green. The macOS storage job reports a wrong indexed-count result in
`concurrent_writes_during_index_creation.test_slow`. The inspected v1.5
backward-compatibility job also failed with test-harness parsing/extension-install
errors. These are distinct from our reproduced WAL failure.

Before a data-preserving rollout, resolve the legacy-WAL compatibility gate with
an upstream fix or an explicit, tested migration. Disposable dev resets do not
need to retain the old WAL, but must not be generalized to other users. Rerun the
[upgrade checklist](../../TESTS.md#duckdb-upgrades-checkpoint-memory-regression-gate),
including NULL-vector handling and platform packaging checks. The isolated Linux
ARM64 live app/progress gate now passes with the configuration above. Windows,
x64 platforms, and desktop packaging were not tested in this evaluation.
The original Windows conflict-save crash remains unconfirmed.

## Commands and evidence

The unchanged repository regression was run against the substituted candidate:

```sh
bun scripts/duckdbCheckpointMemoryRegression.ts
bun test src/server/utils/duckdbServiceNodeApiSpike.test.ts src/server/utils/duckdbServiceTransactionRollback.test.ts src/server/routes/ComparisonProjectsRoutes.rollback.test.ts src/server/reviewServing/reviewServingSummaryProjector.test.ts src/server/reviewServing/reviewServingChunkManifestRepository.test.ts --timeout 120000
```

Separate fresh processes ran `seed`, `checkpoint`, and `compat-reopen` phases
for the cross-version fixture. Real-data probes used APFS clones of preserved
evidence, with a 4 GB engine cap and 8 GiB Linux VM; a separate previously
checkpointed clone was used for the compatibility control. No original DB/WAL
was opened or mutated. All newly started containers and the container service
were stopped after testing.

Local artifacts, hashes, logs, probe scripts, live progress snapshots, the browser
screenshot, and the trial-only configuration diff are preserved under the Forska
diagnostics directory `duckdb-preview-20260908`. No production code changed;
UI builds and lint were not rerun for this engine-evaluation report.
