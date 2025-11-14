// Reindex all indexes in a schema or whole database using local psql

type Scope = 'schema' | 'database'

type Opts = {
  host: string
  port: string
  user: string
  dbname: string
  schema: string
  scope: Scope
  yes: boolean
  noConcurrent: boolean
}

const log = (s: string): void => {
  console.log(`[dbReindexAll] ${s}`)
}

const fail = (s: string): never => {
  console.error(`[dbReindexAll] ${s}`)
  process.exit(1)
}

const parse = (): Opts => {
  const args = process.argv.slice(2)
  const get = (k: string, d: string): string => {
    const i = args.findIndex((a) => a === k)
    return i !== -1 && args[i + 1] ? args[i + 1] : d
  }
  const has = (k: string): boolean => args.includes(k)
  const scopeArg = get('--scope', 'schema') as Scope
  return {
    host: process.env.DB_HOST ?? get('--host', '127.0.0.1'),
    port: process.env.DB_PORT ?? get('--port', '8432'),
    user: process.env.DB_USER ?? get('--user', 'postgres'),
    dbname: process.env.DB_NAME ?? get('--dbname', 'postgres'),
    schema: process.env.DB_SCHEMA ?? get('--schema', 'public'),
    scope: scopeArg === 'database' ? 'database' : 'schema',
    yes: has('--yes') || has('-y'),
    noConcurrent: has('--no-concurrent'),
  }
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

const which = async (cmd: string): Promise<boolean> => {
  const proc = Bun.spawn(['bash', '-lc', `command -v ${cmd} >/dev/null 2>&1`], {stdout: 'ignore', stderr: 'ignore'})
  const code = await proc.exited
  return code === 0
}

const psql = async (opts: Opts, sql: string): Promise<void> => {
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
  if (code !== 0) fail((stderr.trim() || stdout.trim()) || `psql exited with code ${code}`)
}

const main = async (): Promise<void> => {
  const o = parse()
  if (!(await which('psql'))) fail('psql is not installed / not on PATH')
  log(`Target: ${o.user}@${o.host}:${o.port}/${o.dbname} scope=${o.scope} schema=${o.schema}`)
  const action = o.scope === 'database' ? `REINDEX DATABASE${o.noConcurrent ? '' : ' CONCURRENTLY'} ${o.dbname}` : `REINDEX SCHEMA${o.noConcurrent ? '' : ' CONCURRENTLY'} ${o.schema}`
  log(`Planned: ${action}; this may take time and rebuild many indexes.`)
  const cont = o.yes ? true : await promptYN('Proceed? [y/N] ')
  if (!cont) fail('Aborted by user')
  await psql(o, action + ';')
  log('Done')
}

void main()
