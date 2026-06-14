# Review Serving Benchmark Harness

Phase 0 provides a smoke-capable scaffold only. The smoke fixture uses mocked
review-serving work items and admission decisions, so it does not require the
final DuckDB schema, serving tables, or projectors.

The full benchmark fixture is `synthetic10m7PromptOverlap`: 10,000,000
articles, 7 prompts, and 70,000,000 article-prompt overlap rows. That full run
is a Phase 5 release gate and is not required for Phase 0 completion.

The metrics contract records p50, p95, and p99 latency; RSS memory; temp usage;
queue depth; rows scanned; rows returned; and admitted or rejected work.

Phase 5 runs fail if p95 latency exceeds 2,000 ms, p99 latency exceeds 5,000
ms, peak process RSS exceeds 20 GiB, process RSS growth exceeds 4 GiB, or any
accepted foreground sample records DuckDB temp spill.

Smoke command:

```bash
bun run bench:review-serving-smoke
```
