import {$} from 'bun'

const LABEL = 'backfillArticlesImportRoute'

const requireEnv = (k: string): string => {
  const v = process.env[k]
  if (!v) {
    console.error(`[${LABEL}] Missing env var ${k}. Ensure .env is loaded.`)
    process.exit(1)
  }
  return v
}

const log = (s: string): void => {
  console.log(`[${LABEL}] ${s}`)
}

const fail = (s: string): never => {
  console.error(`[${LABEL}] ${s}`)
  process.exit(1)
}

const escapeShell = (s: string): string => {
  return s.replace(/'/g, "'\\''")
}

const assertLocalDbRunning = async (): Promise<void> => {
  const id = (await $.nothrow()`docker compose ps -q db`.text()).trim()
  if (!id) fail('Local db container not found. Start it: docker compose up -d db')
  const running = (await $.nothrow()`docker inspect -f {{.State.Running}} ${id}`.text()).trim()
  if (running !== 'true') fail('Local db is not running. Start it: docker compose up -d db')
}

const runPsqlText = async (db: string, sql: string): Promise<string> => {
  const user = requireEnv('DB_USER')
  const pass = requireEnv('DB_PASS')
  const cmd = `docker compose exec -T -e PGPASSWORD='${escapeShell(pass)}' db psql -U ${user} -d ${db} -v ON_ERROR_STOP=1 -At <<'__SQL__'\n${sql}\n__SQL__`
  const res = await $.nothrow()`bash -lc ${cmd}`
  if (res.exitCode !== 0) fail('psql execution failed')
  return res.text()
}

const toInt = (value: string): number => {
  const n = Number.parseInt(value.trim(), 10)
  return Number.isFinite(n) ? n : 0
}

const formatMs = (ms: number): string => {
  const totalSeconds = Math.max(0, Math.trunc(ms / 1000))
  const seconds = totalSeconds % 60
  const totalMinutes = Math.trunc(totalSeconds / 60)
  const minutes = totalMinutes % 60
  const hours = Math.trunc(totalMinutes / 60)
  const pad2 = (n: number) => {
    return String(n).padStart(2, '0')
  }
  return hours > 0 ? `${hours}:${pad2(minutes)}:${pad2(seconds)}` : `${minutes}:${pad2(seconds)}`
}

const formatPct = (numerator: number, denominator: number): string => {
  const pct = denominator > 0 ? (numerator / denominator) * 100 : 100
  return `${pct.toFixed(1)}%`
}

const getBatchSize = (): number => {
  const env = process.env['BATCH_SIZE']
  const parsed = env ? Number.parseInt(env, 10) : NaN
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 50_000
}

const getMissingCount = async (db: string): Promise<number> => {
  const out = await runPsqlText(
    db,
    `SELECT COUNT(*) FROM articles WHERE import_route IS NULL OR btrim(import_route) = '';`,
  )
  return toInt(out)
}

const runUpdateBatch = async (db: string, batchSize: number): Promise<number> => {
  const sql = `
    WITH todo AS (
      SELECT a.id AS article_id
      FROM articles a
      WHERE a.import_route IS NULL OR btrim(a.import_route) = ''
      ORDER BY a.created_at DESC, a.id DESC
      LIMIT ${batchSize}
    ),
    updated AS (
      UPDATE articles a
      SET import_route = ir.route
      FROM todo
      INNER JOIN article_route_link arl ON arl.article_id = todo.article_id
      INNER JOIN import_route ir ON ir.id = arl.import_route_id
      WHERE a.id = todo.article_id
      RETURNING 1
    )
    SELECT COUNT(*) FROM updated;
  `
  const out = await runPsqlText(db, sql)
  return toInt(out)
}

const runBatches = async (input: {
  db: string
  batchSize: number
  missingTotal: number
  updatedTotal: number
  batchNumber: number
  startedAtMs: number
}): Promise<void> => {
  const batchStartedAtMs = Date.now()
  const updatedThisBatch = await runUpdateBatch(input.db, input.batchSize)
  const batchMs = Date.now() - batchStartedAtMs
  const updatedTotal = input.updatedTotal + updatedThisBatch
  const elapsedMs = Date.now() - input.startedAtMs
  const rate = batchMs > 0 ? Math.round((updatedThisBatch * 1000) / batchMs) : 0
  log(
    `batch=${input.batchNumber} updated=${updatedThisBatch.toLocaleString()} total=${updatedTotal.toLocaleString()} (${formatPct(
      updatedTotal,
      input.missingTotal,
    )}) rate=${rate.toLocaleString()}/s elapsed=${formatMs(elapsedMs)}`,
  )

  return updatedThisBatch === 0
    ? Promise.resolve()
    : runBatches({...input, updatedTotal, batchNumber: input.batchNumber + 1})
}

const main = async (): Promise<void> => {
  const db = requireEnv('DB_NAME')
  const batchSize = getBatchSize()

  await assertLocalDbRunning()

  log(`Starting backfill (batchSize=${batchSize.toLocaleString()})`)
  const missingTotal = await getMissingCount(db)
  log(`Missing import_route (NULL): ${missingTotal.toLocaleString()}`)

  await (missingTotal === 0
    ? Promise.resolve()
    : runBatches({db, batchSize, missingTotal, updatedTotal: 0, batchNumber: 1, startedAtMs: Date.now()}))

  const missingAfter = await getMissingCount(db)
  log(`Missing import_route after: ${missingAfter.toLocaleString()}`)
  return missingAfter === 0 ? log('Backfill complete ✅') : fail('Backfill finished but NULL import_route rows remain')
}

void main()
