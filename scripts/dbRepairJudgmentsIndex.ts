/*
  Repair the primary key index on table `judgments` using local psql.
  Defaults target a remote DB tunneled on localhost:8432.
*/

type Opts = {
  host: string
  port: number
  user: string
  dbname: string
  schema: string
  yes: boolean
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
    noConcurrent: false,
  }
  const args = process.argv.slice(2)
  const next = (i: number): string => {
    return args[i + 1]
  }
  const updated = args.reduce((acc, cur, i) => {
    if (cur === '-h' || cur === '--host') return {...acc, host: next(i)}
    if (cur === '-p' || cur === '--port') return {...acc, port: Number(next(i))}
    if (cur === '-U' || cur === '--user') return {...acc, user: next(i)}
    if (cur === '-d' || cur === '--dbname') return {...acc, dbname: next(i)}
    if (cur === '-s' || cur === '--schema') return {...acc, schema: next(i)}
    if (cur === '-y' || cur === '--yes') return {...acc, yes: true}
    if (cur === '-n' || cur === '--no-concurrent') return {...acc, noConcurrent: true}
    return acc
  }, base)
  return updated
}

const which = async (cmd: string): Promise<boolean> => {
  const proc = Bun.spawn(['bash', '-lc', `command -v ${cmd} >/dev/null 2>&1`], {stdout: 'ignore', stderr: 'ignore'})
  const code = await proc.exited
  return code === 0
}

const runPsql = async (opts: Opts, sql: string): Promise<{code: number; stdout: string; stderr: string}> => {
  const args = [
    '-h',
    opts.host,
    '-p',
    String(opts.port),
    '-U',
    opts.user,
    '-d',
    opts.dbname,
    '-v',
    'ON_ERROR_STOP=1',
    '-c',
    sql,
  ]
  const env = {...process.env}
  const hasPass = typeof env.DB_PASS === 'string' && env.DB_PASS.length > 0
  if (hasPass) env.PGPASSWORD = env.DB_PASS
  const proc = Bun.spawn(['psql', ...args], {stdout: 'pipe', stderr: 'pipe', env})
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  return {code, stdout, stderr}
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

const main = async (): Promise<number> => {
  const opts = parseArgs()
  const ok = await which('psql')
  if (!ok) {
    console.error('[db-repair] psql is not installed / not on PATH')
    return 127
  }

  console.log(
    `[db-repair] Target: ${opts.user}@${opts.host}:${opts.port}/${opts.dbname} schema=${opts.schema} (index ${opts.schema}.judgments_pkey)`,
  )

  const proceed = opts.yes ? true : await promptYN('Proceed with REINDEX? [y/N] ')
  if (!proceed) {
    console.log('[db-repair] Aborted by user')
    return 1
  }

  if (opts.noConcurrent) {
    console.log('[db-repair] Running non-concurrent REINDEX INDEX (locks table briefly)')
    const r = await runPsql(opts, `REINDEX INDEX ${opts.schema}.judgments_pkey;`)
    if (r.code === 0) {
      console.log('[db-repair] Success: non-concurrent REINDEX completed')
      return 0
    }
    console.error('[db-repair] Failure:', r.stderr.trim() || r.stdout.trim())
    return r.code || 1
  }

  console.log(`[db-repair] Attempt 1: REINDEX INDEX CONCURRENTLY ${opts.schema}.judgments_pkey;`)
  const r1 = await runPsql(opts, `REINDEX INDEX CONCURRENTLY ${opts.schema}.judgments_pkey;`)
  if (r1.code === 0) {
    console.log('[db-repair] Success: index rebuilt concurrently')
    return 0
  }
  console.warn('[db-repair] Attempt 1 failed:', (r1.stderr.trim() || r1.stdout.trim()).split('\n').at(-1))

  console.log(`[db-repair] Attempt 2: REINDEX TABLE CONCURRENTLY ${opts.schema}.judgments;`)
  const r2 = await runPsql(opts, `REINDEX TABLE CONCURRENTLY ${opts.schema}.judgments;`)
  if (r2.code === 0) {
    console.log('[db-repair] Success: table reindexed concurrently')
    return 0
  }
  console.error('[db-repair] Attempt 2 failed:', (r2.stderr.trim() || r2.stdout.trim()).split('\n').at(-1))

  console.error('[db-repair] Both concurrent attempts failed.')
  console.error(
    `[db-repair] You can attempt a blocking reindex during a quiet window:\n  DB_PASS=*** psql -h ${opts.host} -p ${opts.port} -U ${opts.user} -d ${opts.dbname} -c 'REINDEX INDEX ${opts.schema}.judgments_pkey;'`,
  )
  console.error('[db-repair] Or force now with: bun scripts/dbRepairJudgmentsIndex.ts --yes --no-concurrent')
  return r2.code || r1.code || 1
}

main().then((code) => {
  process.exit(code)
})
