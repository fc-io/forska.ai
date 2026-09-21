# Priority Work

Status: living design note. The first implementation slice in
`fix/review-serving-priority-lanes` applies lane-first ordering to review-serving
rebuild chunk claims so activation/default-readiness chunks are selected before
bulk background work. Project fair-share scheduling and cross-project delay
diagnostics are still future work.

This note captures the scheduling model we want for review-serving, DuckDB
marts, UI-triggered work, and judgment jobs. It was written after inspecting a
stuck review-serving/search case where one project had locally claimable work,
but the global worker was spending time on another project's much larger
background search backlog.

## Problem

The queue is currently too flat. One priority number is trying to answer three
different questions:

1. What kind of work is this globally?
2. Which project should get the next turn?
3. Within that project, which component should run first?

That makes bad states possible:

- A small project-visible prerequisite can sit behind a huge background backlog.
- A `searchDirtyWork` request can carry prerequisite chunks, then those chunks
  inherit search-like priority even though they are needed for activation.
- The UI can say a project has claimable work while the global scheduler keeps
  choosing unrelated work.
- Completed judgment-job output can exist outside the review page because import
  or status dirty-work is waiting behind bulk search/enrichment.

The fix should split scheduling into lanes and fair-share decisions instead of
only raising or lowering a single request priority.

## Proposed Model

Use three scheduling layers:

1. Pick a global lane.
2. Pick a project fairly inside that lane.
3. Pick the highest-value component inside that project.

Do not fix this by simply making all search high priority. Search should remain
mostly background work. The bug is that prerequisites, current judgment import,
and status projection must not be stranded behind bulk search.

## Global Lanes

Lane order should be explicit. A lane can have a bounded budget or reserve, but
the scheduler should not let lower-value long-running work monopolize the
shared DuckDB owner.

| Lane | Examples | Scheduling rule |
| --- | --- | --- |
| `system-critical` | owner liveness, stale lease release, queue repair, WAL/checkpoint safety, exclusive-owner cleanup | Highest priority, but small bounded batches. This keeps the scheduler and database safe. |
| `foreground-ui` | active route reads/writes, tab counts, default list reads, visible-row hydration, explicit user review actions | Must preempt or backpressure background work. Do not wait behind large rebuilds. |
| `project-visible-writes` | human judgment edits, article selection changes, job outbox import into canonical DuckDB judgment rows, dirty-token ACKs | High priority because source truth or user-visible state changed. Keep batches bounded. |
| `project-status-projection` | `llmStatus`/`humanStatus` dirty patches, list-mode membership, unassessed queue state affected by fresh judgments | Runs before bulk search/posting/summary so current judgments appear quickly. |
| `project-activation` | chunks required to make a candidate/default snapshot usable, such as `projectScope`, `selectedImport`, `display`, core status, and queue prerequisites | Runs before optional enrichment. This is where stranded search prerequisites belong. |
| `project-background` | search indexing, posting buckets, summaries, prompt-answer facets, payload/detail hydration, queue prompt-pair expansion | Fair-share background work. Never monopolize the owner. |
| `global-housekeeping` | retention, old cache cleanup, metrics compaction, diagnostic sweeps | Lowest normal lane unless it is repairing scheduler correctness. Give it a reserve so it eventually runs. |

Important split:

- Global critical repair is above project work.
- Global housekeeping is below project-visible work and below project background
  when users are waiting.

## Between Projects

Inside each project lane, choose projects with fair scheduling, not only raw
priority.

Recommended rules:

- Give every eligible project with visible/status/activation work a turn before
  taking many chunks from the same project again.
- Cap consecutive chunks per project, especially for giant search or posting
  rebuilds.
- Age waiting projects upward so low priority does not mean never.
- Boost projects that are currently viewed in the UI or recently produced a
  warning banner.
- Boost projects with no active usable snapshot.
- Boost projects with running or recently completed judgment jobs whose import
  or status projection is lagging.
- Keep background work moving with a small reserve, but do not let one project
  consume the whole reserve for hours.

This means another project can keep chewing through a 198k-chunk search
backlog, but it should not prevent a small three-range activation/status set in
the current project from running.

## Within One Project

Once a project has a turn, pick work by user impact and unblock value.

Recommended order:

1. Source-of-truth writes and control actions:
   - human judgment edits
   - article selection changes
   - job start/pause/drain/repair state transitions
   - job SQLite outbox import into canonical DuckDB judgment rows
2. Current judgment visibility:
   - imported judgment high-watermark updates
   - `llmStatus` dirty patches
   - `humanStatus` dirty patches
   - list-mode membership and unassessed queue updates affected by those changes
3. Snapshot/default-readiness prerequisites:
   - `projectScope`
   - `selectedImport`
   - `display`
   - core `llmStatus`
   - core `humanStatus`
   - core `queue`
4. Default review-page surfaces:
   - unfiltered row reads
   - default tab counts
   - filter counts that depend only on ready status/list-mode state
   - visible-row hydration needed for the current page
5. Search and search-specific work:
   - search index chunks
   - bounded foreground search fallback for a user-initiated query
6. Optional and lazy surfaces:
   - prompt-answer posting buckets
   - prompt-derived summary/facet/filter-option work
   - full judgment detail payload hydration
   - queue prompt-pair payload expansion
   - enrichment cleanup

Search-specific UI should not promote the entire search backlog. It may promote
only the bounded key/range needed to answer the active user request, or return a
clear pending state.

## UI-Triggered Work

UI work should be treated as either foreground interaction or explicit
on-demand materialization.

Foreground interaction:

- default review list load
- tab switching
- default counts
- visible article row opening
- human judgment edit
- article selection change
- job start/pause/drain/repair command

These should not enqueue unbounded background rebuilds synchronously. They
should either use already-ready default surfaces, perform bounded foreground
work for the specific key, or return an explicit pending/stale state.

On-demand materialization:

- search query where the search index is missing
- prompt-answer filter bucket
- prompt-derived facets
- detail/payload hydration outside the visible page
- queue prompt-pair preview for job launch

These can enqueue `project-background` work, with a temporary UI-interest boost
for the requested project/key. The boost should be narrow and time-limited so
one UI click does not turn all optional enrichment into foreground work.

The UI should expose the real wait reason when possible:

- waiting for this project's activation chunk
- waiting for this project's status projection
- waiting behind higher-priority work in another project
- waiting behind system-critical work
- paused, failed, quarantined, or budget-limited

## Judgment Jobs

Judgment jobs have two separate kinds of work: producing judgments and making
them visible.

Producing judgments:

- provider/model dispatch
- request attempts
- per-job SQLite state
- runtime heartbeat and leases
- provider telemetry

This work is important, but it should be governed by provider limits and job
fairness rather than DuckDB mart priority alone.

Making judgments visible:

- import completed SQLite outbox rows into canonical DuckDB `app.judgment`
- advance import high-watermarks
- mark review-serving dirty work
- apply `llmStatus` dirty patches
- refresh affected list-mode/unassessed queue state
- update job/admin health projections

This second group should be high priority once judgments exist. The model call
has already been paid for; users should not wait behind search indexing before
new judgments appear in rows/counts/status tabs.

Recommended job priorities:

1. Job control and safety:
   - pause/drain/quarantine/repair/preflight
   - stale import lease repair
   - orphaned queue repair
2. Completed-result import:
   - SQLite outbox flush into DuckDB
   - canonical judgment insert/update/tombstone
   - import marker advancement
3. Status projection:
   - `llmStatus`/`humanStatus` dirty patches
   - list-mode and unassessed queue updates affected by the new judgments
4. Job health/read model:
   - admin job progress
   - worker heartbeats
   - storage health projection
5. Optional job-adjacent materialization:
   - queue prompt-pair payload expansion
   - full detail payloads
   - prompt-answer buckets needed only for preview/filter workflows

The key invariant:

If a job has completed judgments ready for import, bulk search/posting/summary
work must not prevent those judgments from becoming visible in the review page.

## Specific Fix Direction For The Observed Search Case

For a pure `searchDirtyWork` request:

- Keep actual search chunks in `project-background`.
- If the request needs prerequisite/default-readiness chunks, classify those
  chunks as `project-activation`.
- Do not let prerequisite chunks inherit low bulk-search priority.
- Prefer reusing/adopting already-complete prerequisite components when safe,
  instead of creating a fresh candidate that has to rebuild every prerequisite.

Required diagnostic invariant:

If a project has `claimableCount > 0`, an eligible worker, no pause, and no
failures, then one of these must become true within a bounded window:

- at least one chunk is claimed, or
- diagnostics identify the higher lane/project currently delaying it.

This prevents "locally claimable but globally invisible" states.

## Suggested Implementation Slices

1. Add scheduler diagnostics first:
   - selected lane
   - selected project
   - skipped lane/project reason
   - per-project consecutive chunk count
   - higher-priority work blocking a claimable project
2. Split chunk classification from request reason:
   - request reason may be `searchDirtyWork`
   - chunk lane can still be `project-activation` for prerequisites
3. Add project fair-share selection:
   - cap consecutive background chunks per project
   - age waiting projects
   - apply UI/job lag boosts
4. Prioritize completed judgment visibility:
   - import outbox rows before bulk search
   - run status dirty patches before optional enrichment
5. Make UI pending states more honest:
   - distinguish activation, status projection, search, and global backlog
6. Add regression tests for the stuck shape:
   - huge background search backlog in project A
   - small activation/status/search-prerequisite set in project B
   - project B must claim within a bounded scheduler window

## Quality Gates For Future Changes

Docs-only update:

- `git diff --check`

Scheduler/database implementation:

- Targeted unit tests for lane ordering and per-project fair-share behavior.
- Regression test for `searchDirtyWork` prerequisites not being stranded behind
  bulk search.
- Regression test for completed judgment outbox import and `llmStatus` status
  projection running ahead of bulk search/posting/summary.
- Route or service test proving warnings/status diagnostics explain why a
  claimable project is not being claimed.
- Concurrency test showing foreground review routes stay responsive while
  background search/posting work is running.
- `bun run db:mig` for migration changes.
- Relevant `bun test <file>` commands for touched scheduler, review-serving, or
  judgment-job modules.
- `bun run lint` for touched TypeScript.
