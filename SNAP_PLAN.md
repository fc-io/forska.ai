# SNAP Plan

## Goal

- keep writer queue for writes + freshness-critical reads
- move heavy OLAP reads to short-lived snapshot readers
- reuse snapshot for 5-10s; avoid per-request snapshot creation

## Good snapshot candidates

- `/api/judgmentsjobs-unassessed-count` - stale-tolerant count, already cached
- `/api/judgmentsjobs-unassessed-articles` - stale-tolerant list
- `/api/articlesreviewscount` - heavy rollup count
- `/api/articlesreviews` - heavy paged OLAP read; keep hydration step separate if needed
- `/api/articlesreviewsboth` - heavy rollup + judgments read
- `/api/articlesreviewsunassessed` - heavy rollup read
- `/api/articlesreviewsfilters` - distinct/min-max filter discovery
- `/api/articles/pdf-fetch-by-filter` - snapshot-safe for selection step only
- `/api/projects/add_articles_by_filter` - snapshot-safe for selection step only

## Keep live

- `/api/projects/:id`, `/api/projects/:id/access`
- `/api/judgmentsjobs`, `/api/judgmentsjobs/:id`
- all writes / transactions / archive / clone / edit flows
- post-write confirmation reads where freshness matters immediately

## Shape

- create snapshot via existing snapshot helper
- pass snapshot `duckdbPath` into OLAP runner
- route only heavy read helpers to snapshot path
- expire + delete old snapshots
- fall back to live path if snapshot path fails
