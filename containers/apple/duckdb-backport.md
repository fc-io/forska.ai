# DuckDB checkpoint memory backport

Scope: database engine and container build; no application schema or authoritative-row changes. The Apple container uses a patched Linux ARM64 DuckDB library. Host web and desktop installations are not replaced by this container build.

## Pinned provenance

| Component | Revision |
| --- | --- |
| Stable DuckDB base | `v1.5.5`, `d8cdaa33fda8df955cc76ef58a280f68f4cd43fa` |
| [Upstream #23964: shrink deleted-row memory](https://github.com/duckdb/duckdb/pull/23964) | `929a0e336b2dfdc2653b5c833bd76af189f29c37` |
| [Upstream #24336: partial-delete bitmasks](https://github.com/duckdb/duckdb/pull/24336) | `1da80a4a3adef9053fb665864734debf1407a521` |
| Local combined patch | `duckdb-checkpoint-backport.patch` |
| Patch SHA-256 | `9d9a2adbcc22891e4f4aada3d0235da7fb154f7137b9ce01d4c64aa9bf069b70` |
| Non-unity build include patch | `duckdb-nonunity-includes.patch`, SHA-256 `0de036117f2b40246c2629b2a2fa798f9b6e7c04e18a653057583c1a866300ce` |

These changes are merged upstream but absent from stable 1.5.5. The patch is a reviewed backport, not an unmodified upstream cherry-pick. Build-time source and patch checksum verification belongs to `buildDuckdb.sh`.

The separate non-unity patch adds the missing `string_util.hpp` include to `allocator_jemalloc.cpp`. It permits the memory-bounded non-unity build and changes no runtime behavior.

## Cause and implementation

A full checkpoint visits persisted row-group deletion metadata while deciding which groups can be compacted. Stable DuckDB inflates partial-delete masks into per-row transaction-ID arrays backed by non-spillable `BASE_TABLE` allocations. Fragmented historical groups can exhaust a small memory budget even when their live contents are tiny. Setting `max_vacuum_tasks=0` does not avoid this initial metadata load.

The backport retains compact masks when reading persisted partial deletes, represents fully deleted vectors with a constant ID, and compresses committed in-memory version IDs only when the oldest active snapshot permits it. Empty allocator buffers are released. This fixes the representation and lifetime of deletion state; it does not skip full checkpoints, discard WAL, or raise the memory limit.

| Source area | Change |
| --- | --- |
| `chunk_info.hpp/.cpp` | Constant/masked/array delete states, compatible serialization, transaction-aware compression, later-delete and rollback handling. |
| `row_version_manager.hpp/.cpp` | Unified vector information, compression eligibility tracking, empty-buffer release. |
| `row_group.hpp/.cpp`, `row_group_collection.cpp` | Checkpoint compression using the oldest active transaction watermark. |
| `enum_util.hpp/.cpp` | String conversions for the two new internal enums. |
| Upstream SQL tests and force-storage configuration | Original upstream regression coverage included with the patch. |

### Backport adaptations

- Keep 1.5.5's `GetCommittedDeletedCount` and `GetCheckpointRowCount` methods on the unified vector class, preserving the stable callers instead of importing unrelated scan refactors.
- Add the transaction-manager include at the stable source's existing include boundary; retain stable row-ID and checkpoint scheduling logic.
- Use the existing `SerializationException` for invalid persisted masks because 1.5.5 does not define upstream's newer `DataCorruptionException`. The error still identifies malformed persisted data.
- Place generated enum conversions in the stable enum table; do not import unrelated newer enums.

The resulting `chunk_info.cpp` matches the merged #24336 implementation except for the two preserved stable methods and the exception type adaptation.

## Compatibility review

- The public DuckDB C API is unchanged by this patch. Comparing the official 1.5.1 and 1.5.5 `duckdb.h` headers also finds no removed or changed existing function signatures or struct layouts; newer enum values and a geometry helper are additive. The container retains the locked `@duckdb/node-bindings` 1.5.1-r.1 C-API bridge and replaces only its shared engine library. Exact package-version matching is not required for this existing C-API surface, but this custom pairing must pass the Node load/query/transaction and regression gates below. It does not add high-level Node support for new 1.5.5 data types.
- Internal C++ classes do change; this is not a promise of C++ ABI compatibility. Build the complete engine; do not mix internal C++ objects from different builds. The Node bridge consumes `duckdb.h`, not the modified internal C++ classes.
- Persistent tags remain `EMPTY_INFO`, `CONSTANT_INFO`, and `VECTOR_INFO`; partial deletes retain the existing validity-mask encoding and orientation. No storage-version upgrade is introduced.
- Memory-only masks preserve their visibility watermark. Old snapshots, subsequent deletes, write conflicts, commit, and rollback are covered by the upstream regression cases; the memory-only state must never erase snapshot-visible rows.
- A container-only engine fix does not establish that the original Windows conflict-resolution failure is solved.

## Quality gates

Source review completed: all five changed C++ translation units pass `clang++ -std=c++11 -fsyntax-only -Isrc/include -Ithird_party/fmt/include`, with and without `-DDEBUG`; `git diff --check` passes.

Runtime verification completed on 2026-09-08:

| Gate | Result |
| --- | --- |
| Linux ARM64 build and locked Node bridge | Built, loaded, and executed database queries successfully. |
| Original upstream transaction/storage regressions | All 13 cases passed; the image build rejects skipped cases. |
| Fragmented-row regression | Unpatched engine failed; patched full checkpoint and fresh-process reopen passed at 32 MiB, preserving expected row count, ID sum, and WAL-only marker. |
| Older host engine compatibility | The host's unpatched 1.5.1 engine reopened the patched fixture and verified its contents. |
| Approximately 123 GB current database | Normal full checkpoint passed at the original 4 GB DuckDB / 8 GiB VM limits in approximately 13 seconds; completion RSS was 2,112,262,144 bytes (2.11 GB decimal). No concurrent-checkpoint workaround was used. |
| Live application progress | API/owner readiness passed and completed workload chunks advanced by 52. |

The build log records the native tests and synthetic regression; `forska-patched-real-checkpoint-20260908.log` records the timed current-DB checkpoint. These are targeted results, not an engine-wide correctness guarantee or confirmation of the separate Windows conflict-resolution cause.

Required gates for subsequent changes:

1. Build and load the patched Linux ARM64 engine through the locked Node C-API bridge, and verify actual queries and transaction behavior.
2. Run the repository's `scripts/duckdbCheckpointMemoryRegression.ts` against unpatched and patched engines: unchanged budget and fixture, checkpoint failure before the patch, successful checkpoint and exact fresh-process data verification after it.
3. Run the original upstream SQL cases listed below, including named-connection/snapshot and restart behavior, against the patched engine.
4. Verify a full checkpoint on a preserved current-DB clone at the original 4 GB DuckDB / 8 GiB VM limits, then verify app/API/owner readiness and real current-DB progress. Preserve pre-test DB/WAL evidence.

Upstream regression files included:

- `test/sql/delete/bulk_delete_version_info_memory.test`
- `test/sql/delete/delete_compression_after_restart.test`
- `test/sql/delete/delete_compression_blocked_by_old_snapshot.test`
- `test/sql/delete/full_vector_delete_conflict.test`
- `test/sql/delete/full_vector_delete_rollback.test`
- `test/sql/delete/masked_vector_further_delete.test`
- `test/sql/delete/masked_vector_rollback.test`
- `test/sql/delete/partial_delete_version_info_memory.test`
- `test/sql/delete/piecemeal_delete_checkpoint_compress.test_slow`
- `test/sql/storage/full_vector_delete_checkpoint.test`
- `test/sql/storage/partial_delete_checkpoint_mask.test`
- `test/sql/storage/partial_delete_pending_compress.test`
- `test/sql/storage/piecemeal_delete_checkpoint_compress.test`

## Removal criterion

Every DuckDB dependency or engine upgrade must run the
[DuckDB upgrade gate in TESTS.md](../../TESTS.md#duckdb-upgrades-checkpoint-memory-regression-gate)
against the actual candidate engine, including an unpatched official build when
evaluating removal of this backport.

When an official stable DuckDB/Node binding release contains both upstream fixes, replace the custom build with that pinned official package and remove the patch/build override in the same change. First rerun the synthetic regression, upstream transaction/rollback cases, and current-DB progress gate at the same memory limits. Do not keep patched and unpatched container engine paths as permanent alternatives.
