// Deduplicate primary keys (id) in tables, then reindex schema/database.
// Assumes an SSH tunnel to the remote DB (default localhost:8432).

type Scope = 'schema' | 'database'

type Opts = {
  host: string
  port: number
  user: string
  dbname: string
  schema: string
  yes: boolean
  scope: Scope
  noConcurrent: boolean
}

const parseArgs = (): Opts => {
  const envPort = Number(process.env.DB_PORT ?? 8432)
  const base: Opts = {
    host: process.env.DB_HOST ?? '127.0.0.1',
    port: Number.isFinite(envPort) ? envPort : 8432,
    user: process.env.DB_USER ?? 'postgres',
    dbname: process.env.DB_NAME ?? 'postgres',
    schema: process.env.DB_SCHEMA ?? 'public',
    yes: false,
    scope: (process.argv.includes('--scope')
      ? (process.argv[process.argv.indexOf('--scope') + 1] as Scope)
      : 'schema') as Scope,
    noConcurrent: process.argv.includes('--no-concurrent'),
  }
  return base
}

const which = async (cmd: string): Promise<boolean> => {
  const proc = Bun.spawn(['bash', '-lc', `command -v ${cmd} >/dev/null 2>&1`], {stdout: 'ignore', stderr: 'ignore'})
  const code = await proc.exited
  return code === 0
}

const spawnPsql = (args: string[], env: Record<string, string | undefined>) => {
  return Bun.spawn(['psql', ...args], {stdout: 'pipe', stderr: 'pipe', env})
}

const runPsql = async (opts: Opts, sql: string): Promise<{code: number; stdout: string; stderr: string}> => {
  const args = ['-h', opts.host, '-p', String(opts.port), '-U', opts.user, '-d', opts.dbname, '-v', 'ON_ERROR_STOP=1', '-c', sql]
  const env = {...process.env}
  if (env.DB_PASS) env.PGPASSWORD = env.DB_PASS
  const proc = spawnPsql(args, env)
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  return {code, stdout, stderr}
}

const runQuery = async (opts: Opts, sql: string): Promise<string[]> => {
  const args = ['-h', opts.host, '-p', String(opts.port), '-U', opts.user, '-d', opts.dbname, '-A', '-t', '-q', '-c', sql]
  const env = {...process.env}
  if (env.DB_PASS) env.PGPASSWORD = env.DB_PASS
  const proc = spawnPsql(args, env)
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  if (code !== 0) throw new Error((stderr.trim() || stdout.trim()) || `psql exited with ${code}`)
  return stdout
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

const runQueryAuto = async (opts: Opts, sql: string): Promise<string[]> => {
  try {
    return await runQuery(opts, sql)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    const fixed = await reindexFromErrorIfPossible(opts, msg)
    if (!fixed) throw e
    return await runQuery(opts, sql)
  }
}

const qualifyIndex = (schema: string, idx: string): string => {
  return idx.includes('.') ? idx : `${schema}.${idx}`
}

const reindexIndex = async (opts: Opts, idx: string): Promise<void> => {
  const q = qualifyIndex(opts.schema, idx)
  const r = await runPsql(opts, `REINDEX INDEX ${opts.noConcurrent ? '' : 'CONCURRENTLY '} ${q};`.replace(/\s+/g, ' '))
  if (r.code !== 0) throw new Error(r.stderr.trim() || r.stdout.trim())
}

const reindexFromErrorIfPossible = async (opts: Opts, errText: string): Promise<boolean> => {
  // Try to parse index name patterns from common corruption messages
  const patterns = [
    /index\s+"([^"]+)"/i,
    /in\s+index\s+"([^"]+)"/i,
  ]
  for (const re of patterns) {
    const m = errText.match(re)
    if (m && m[1]) {
      const idx = m[1]
      try {
        console.warn(`[db-repair-all] Detected corrupt index '${idx}', reindexing...`)
        await reindexIndex(opts, idx)
        console.warn(`[db-repair-all] Reindexed '${idx}'`) 
        return true
      } catch (e) {
        console.error(`[db-repair-all] Failed to reindex '${idx}':`, e instanceof Error ? e.message : String(e))
        return false
      }
    }
  }
  return false
}

const promptYN = async (q: string): Promise<boolean> => {
  process.stdout.write(q)
  const chunks: Uint8Array[] = []
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Uint8Array)
    break
  }
  const ans = Buffer.concat(chunks).toString('utf8').trim().toLowerCase()
  return ans === 'y' || ans === 'yes'
}

const listTablesWithSingleIdPk = async (opts: Opts): Promise<string[]> => {
  const sql = `
    SELECT c.relname
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_index i ON i.indrelid = c.oid AND i.indisprimary
    JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = ANY(i.indkey)
    WHERE n.nspname = '${opts.schema}'
      AND array_length(i.indkey, 1) = 1
      AND a.attname = 'id'
      AND c.relkind = 'r';
  `
  return runQueryAuto(opts, sql)
}

const tableHasColumn = async (opts: Opts, table: string, col: string): Promise<boolean> => {
  const sql = `
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = '${opts.schema}' AND table_name = '${table}' AND column_name = '${col}'
    LIMIT 1;
  `
  const rows = await runQueryAuto(opts, sql)
  return rows.length > 0
}

const countPkDuplicates = async (opts: Opts, table: string): Promise<number> => {
  const sql = `
    SELECT COALESCE(SUM(cnt),0) FROM (
      SELECT COUNT(*) AS cnt
      FROM ${opts.schema}."${table}"
      GROUP BY id
      HAVING COUNT(*) > 1
    ) s;
  `
  const rows = await runQueryAuto(opts, sql)
  const val = Number(rows[0] ?? '0')
  return Number.isFinite(val) ? val : 0
}

const dedupeTable = async (opts: Opts, table: string): Promise<void> => {
  const hasCreated = await tableHasColumn(opts, table, 'created_at')
  const hasUpdated = await tableHasColumn(opts, table, 'updated_at')
  const orderExpr = [hasCreated ? 'created_at DESC NULLS LAST' : '', hasUpdated ? 'updated_at DESC NULLS LAST' : '', 'ctid DESC']
    .filter(Boolean)
    .join(', ')
  const sql = `
    WITH dups AS (
      SELECT id, ctid, row_number() OVER (PARTITION BY id ORDER BY ${orderExpr}) AS rn
      FROM ${opts.schema}."${table}"
    )
    DELETE FROM ${opts.schema}."${table}" t
    USING dups
    WHERE t.ctid = dups.ctid AND dups.rn > 1;
  `
  // Try once; on error, attempt to reindex the specific corrupt index, then retry once.
  let r = await runPsql(opts, sql)
  if (r.code !== 0) {
    const msg = (r.stderr.trim() || r.stdout.trim())
    const fixed = await reindexFromErrorIfPossible(opts, msg)
    if (!fixed) throw new Error(msg)
    r = await runPsql(opts, sql)
    if (r.code !== 0) throw new Error((r.stderr.trim() || r.stdout.trim()))
  }
}

const reindex = async (opts: Opts): Promise<void> => {
  const action = opts.scope === 'database' ? `REINDEX DATABASE${opts.noConcurrent ? '' : ' CONCURRENTLY'} ${opts.dbname}` : `REINDEX SCHEMA${opts.noConcurrent ? '' : ' CONCURRENTLY'} ${opts.schema}`
  const r = await runPsql(opts, action + ';')
  if (r.code !== 0) throw new Error(r.stderr.trim() || r.stdout.trim())
}

const main = async (): Promise<number> => {
  const opts = parseArgs()
  if (!(await which('psql'))) {
    console.error('[db-repair-all] psql is not installed / not on PATH')
    return 127
  }
  console.log(`[db-repair-all] Target: ${opts.user}@${opts.host}:${opts.port}/${opts.dbname} schema=${opts.schema} scope=${opts.scope}`)
  const proceed = opts.yes ? true : await promptYN('[db-repair-all] Deduplicate PK(id) across tables and reindex. Proceed? [y/N] ')
  if (!proceed) {
    console.log('[db-repair-all] Aborted by user')
    return 1
  }

  // 1) Find tables and deduplicate if necessary
  const tables = await listTablesWithSingleIdPk(opts)
  console.log(`[db-repair-all] Found ${tables.length} tables with single-column PK(id)`)
  for (const t of tables) {
    const dups = await countPkDuplicates(opts, t)
    if (dups > 0) {
      console.log(`[db-repair-all] ${t}: removing ${dups} duplicate row(s) by id`)
      await dedupeTable(opts, t)
    }
  }

  // 2) Reindex
  console.log(`[db-repair-all] Reindexing (${opts.scope})${opts.noConcurrent ? ' (blocking)' : ' (concurrent)'}`)
  await reindex(opts)
  console.log('[db-repair-all] Done')
  return 0
}

main().then((code) => process.exit(code))
