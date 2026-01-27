import {$} from 'bun'

type TableStats = {count: number; maxUpdatedAtMs: number | null}

const toNumber = (value: unknown): number => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0
  if (typeof value === 'bigint') return Number(value)
  if (typeof value === 'string') return parseInt(value, 10) || 0
  return 0
}

const toMsOrNull = (value: unknown): number | null => {
  if (value === null || value === undefined) return null
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'bigint') return Number(value)
  if (typeof value === 'string') {
    const n = Number(value)
    return Number.isFinite(n) ? n : null
  }
  return null
}

const formatCount = (value: number | null | undefined): string => {
  return value === null || value === undefined ? 'N/A' : value.toLocaleString()
}

const formatTime = (ms: number | null | undefined): string => {
  return ms === null || ms === undefined ? 'N/A' : new Date(ms).toISOString()
}

const parseDatabaseUrl = (raw: string) => {
  const url = new URL(raw)
  const username = decodeURIComponent(url.username || 'postgres')
  const password = decodeURIComponent(url.password || '')
  const database = url.pathname.replace(/^\//, '') || 'postgres'
  return {username, password, database}
}

const getPgCredentials = () => {
  const urlRaw = String(process.env['DATABASE_URL'] ?? '').trim()
  const parsed = urlRaw ? parseDatabaseUrl(urlRaw) : {username: 'postgres', password: '', database: 'postgres'}

  return {
    user: String(process.env['DB_USER'] ?? parsed.username ?? 'postgres') || 'postgres',
    password: String(process.env['DB_PASS'] ?? parsed.password ?? ''),
    database: String(process.env['DB_NAME'] ?? parsed.database ?? 'postgres') || 'postgres',
  }
}

const getClickhousePassword = () => {
  return String(process.env['CLICKHOUSE_PASSWORD'] ?? 'clickhouse')
}

const runCmdText = async (label: string, cmd: ReturnType<typeof $>): Promise<string> => {
  const res = await cmd.quiet().nothrow()
  const stdout = res.stdout.toString()
  const stderr = res.stderr.toString()
  if (res.exitCode !== 0) {
    console.error(`[recountPgChSync] ${label} failed (exit=${res.exitCode})`)
    if (stdout.trim()) console.error(stdout.trim())
    if (stderr.trim()) console.error(stderr.trim())
    process.exit(1)
  }
  return stdout.trim()
}

const parsePgStatsLine = (line: string): TableStats => {
  const [countRaw, maxRaw] = line.trim().split(',')
  const maxMsRaw = maxRaw === undefined || maxRaw.trim() === '' ? null : maxRaw.trim()
  return {count: toNumber(countRaw), maxUpdatedAtMs: toMsOrNull(maxMsRaw)}
}

const queryPgTableStats = async (input: {
  table: 'articles' | 'judgments'
  where: string
}): Promise<TableStats> => {
  const {user, password, database} = getPgCredentials()
  const query = `
    SELECT
      COUNT(*)::bigint AS count,
      (EXTRACT(EPOCH FROM MAX(updated_at)) * 1000)::bigint AS max_updated_at_ms
    FROM ${input.table}
    ${input.where};
  `

  const out = await runCmdText(
    `pg:${input.table}`,
    $`docker compose exec -T -e PGPASSWORD=${password} db psql -U ${user} -d ${database} -t -A -F ',' -c ${query}`,
  )

  return out ? parsePgStatsLine(out.split(/\r?\n/)[0] ?? '') : {count: 0, maxUpdatedAtMs: null}
}

const parseChJsonLine = (line: string): Record<string, unknown> => {
  const normalized = line.trim()
  return normalized ? (JSON.parse(normalized) as Record<string, unknown>) : {}
}

const queryClickhouseStats = async (label: string, query: string): Promise<TableStats> => {
  const password = getClickhousePassword()
  const out = await runCmdText(
    `ch:${label}`,
    $`docker compose exec -T clickhouse clickhouse-client --password ${password} -q ${query}`,
  )

  const row = parseChJsonLine(out.split(/\r?\n/)[0] ?? '')
  return {count: toNumber(row['count']), maxUpdatedAtMs: toMsOrNull(row['maxUpdatedAtMs'])}
}

const getStatusLabel = (diff: number): string => {
  return diff === 0 ? 'synced' : diff > 0 ? 'pg_ahead' : 'ch_ahead'
}

const main = async (): Promise<void> => {
  const startedAt = new Date().toISOString()
  const outputJson = process.argv.includes('--json')

  const [pgArticles, pgJudgments, chArticles, chJudgmentsRaw, chJudgmentsView] = await Promise.all([
    queryPgTableStats({table: 'articles', where: ''}),
    queryPgTableStats({table: 'judgments', where: 'WHERE deleted_at IS NULL'}),
    queryClickhouseStats(
      'articles_live',
      `
        SELECT
          count() AS count,
          if(count() = 0, NULL, toUnixTimestamp64Milli(max(updated_at))) AS maxUpdatedAtMs
        FROM forska.articles FINAL
        WHERE _peerdb_is_deleted = 0
        FORMAT JSONEachRow
      `,
    ),
    queryClickhouseStats(
      'judgments_raw_live',
      `
        SELECT
          count() AS count,
          if(count() = 0, NULL, toUnixTimestamp64Milli(max(updated_at))) AS maxUpdatedAtMs
        FROM forska.judgments_raw FINAL
        WHERE deleted_at IS NULL AND _peerdb_is_deleted = 0
        FORMAT JSONEachRow
      `,
    ),
    queryClickhouseStats(
      'judgments_live',
      `
        SELECT
          count() AS count,
          if(count() = 0, NULL, toUnixTimestamp64Milli(max(updatedAt))) AS maxUpdatedAtMs
        FROM forska.judgments FINAL
        WHERE _peerdb_is_deleted = 0
        FORMAT JSONEachRow
      `,
    ),
  ])

  const articlesDiff = pgArticles.count - chArticles.count
  const judgmentsDiff = pgJudgments.count - chJudgmentsView.count
  const synced = articlesDiff === 0 && judgmentsDiff === 0
  const chHasAny = chArticles.count > 0 || chJudgmentsView.count > 0 || chJudgmentsRaw.count > 0

  const data = {
    startedAt,
    articles: {pg: pgArticles, ch: chArticles, diff: articlesDiff, status: getStatusLabel(articlesDiff)},
    judgments: {
      pg: pgJudgments,
      chRaw: chJudgmentsRaw,
      ch: chJudgmentsView,
      diff: judgmentsDiff,
      status: getStatusLabel(judgmentsDiff),
    },
    summary: {synced, chHasAny},
  }

  if (outputJson) {
    console.log(JSON.stringify(data))
    process.exit(synced ? 0 : 2)
  }

  console.log(`[recountPgChSync] started_at=${startedAt}`)

  console.log('articles')
  console.log(`  pg: count=${formatCount(pgArticles.count)} max_updated_at=${formatTime(pgArticles.maxUpdatedAtMs)}`)
  console.log(`  ch: count=${formatCount(chArticles.count)} max_updated_at=${formatTime(chArticles.maxUpdatedAtMs)}`)
  console.log(`  diff=${formatCount(articlesDiff)} status=${getStatusLabel(articlesDiff)}`)

  console.log('judgments (live)')
  console.log(`  pg: count=${formatCount(pgJudgments.count)} max_updated_at=${formatTime(pgJudgments.maxUpdatedAtMs)}`)
  console.log(
    `  ch_raw: count=${formatCount(chJudgmentsRaw.count)} max_updated_at=${formatTime(chJudgmentsRaw.maxUpdatedAtMs)}`,
  )
  console.log(
    `  ch_view: count=${formatCount(chJudgmentsView.count)} max_updated_at=${formatTime(chJudgmentsView.maxUpdatedAtMs)}`,
  )
  console.log(`  diff=${formatCount(judgmentsDiff)} status=${getStatusLabel(judgmentsDiff)}`)

  console.log(`summary synced=${synced ? 'yes' : 'no'} ch_has_any=${chHasAny ? 'yes' : 'no'}`)
  process.exit(synced ? 0 : 2)
}

void main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error ?? 'unknown error')
  console.error(`[recountPgChSync] failed: ${message}`)
  process.exit(1)
})

