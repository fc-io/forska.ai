import {$} from 'bun'
import {mkdirSync, readdirSync, statSync} from 'fs'
import {basename} from 'path'
import readline from 'node:readline/promises'
import {stdin as input, stdout as output} from 'node:process'
import {env} from './env.ts'

type TableMeta = {
  table: string
  pkeys: string[]
  cols: string[]
  updatable: string[]
}

const log = (s: string): void => {
  console.log(`[dbMerge] ${s}`)
}

const fail = (s: string): never => {
  console.error(`[dbMerge] ${s}`)
  process.exit(1)
}

const nowStamp = (): string => {
  const d = new Date()
  const p = (n: number): string => (n < 10 ? `0${n}` : `${n}`)
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

const latestFileMatching = (dir: string, prefix: string): string | undefined => {
  const files = readdirSync(dir).filter((f) => f.startsWith(prefix))
  const dated = files.map((f) => ({f, mtime: statSync(`${dir}/${f}`).mtimeMs}))
  const sorted = dated.sort((a, b) => b.mtime - a.mtime)
  return sorted[0]?.f ? `${dir}/${sorted[0].f}` : undefined
}

const assertLocalDbRunning = async (): Promise<void> => {
  const id = (await $.nothrow()`docker compose ps -q db`.text()).trim()
  if (!id) fail('Local db container not found. Start it: docker compose up -d db')
  const running = (await $.nothrow()`docker inspect -f {{.State.Running}} ${id}`.text()).trim()
  if (running !== 'true') fail('Local db is not running. Start it: docker compose up -d db')
}

const escapeShell = (s: string): string => s.replace(/'/g, "'\\''")
const hasArg = (a: string): boolean => process.argv.includes(a)
const confirmUse = async (file: string): Promise<void> => {
  if (hasArg('--yes') || hasArg('-y')) return
  const rl = readline.createInterface({input, output})
  const ans = (await rl.question(`Use remote dump: ${file}? [y/N] `)).trim().toLowerCase()
  rl.close()
  if (!(ans === 'y' || ans === 'yes')) fail('Cancelled by user')
}

const backupLocal = async (): Promise<string> => {
  const user = env.DB_USER
  const pass = env.DB_PASS
  const db = env.DB_NAME
  mkdirSync('backups', {recursive: true})
  const out = `backups/dump_local_${db}_${nowStamp()}.dump`
  log(`Backing up local DB -> ${out}`)
  const cmd = `docker compose exec -e PGPASSWORD='${escapeShell(pass)}' -T db pg_dump -U ${user} -d ${db} -Fc -Z 9 > ${out}`
  const res = await $.nothrow()`bash -lc ${cmd}`
  if (res.exitCode !== 0) fail('Local pg_dump failed')
  return out
}

const getRemoteDump = async (): Promise<string> => {
  mkdirSync('backups', {recursive: true})
  const latest = latestFileMatching('backups', 'dump_remote_')
  return latest ?? fail('No remote dump found. Place a file matching backups/dump_remote_*.dump')
}

const copyDumpIntoContainer = async (hostPath: string): Promise<string> => {
  const fname = basename(hostPath)
  const dest = `/tmp/${fname}`
  log(`Copy dump into container: ${fname}`)
  const cp = await $.nothrow()`docker compose cp ${hostPath} db:${dest}`
  if (cp.exitCode !== 0) fail('docker compose cp failed')
  return dest
}

const createTempDb = async (tempDb: string): Promise<void> => {
  log(`Create temp database ${tempDb}`)
  await $.nothrow()`docker compose exec -T db dropdb -U ${env.DB_USER} --if-exists ${tempDb}`
  const createdb = await $.nothrow()`docker compose exec -T db createdb -U ${env.DB_USER} ${tempDb}`
  if (createdb.exitCode !== 0) fail('createdb failed')
}

const restoreDumpToDb = async (containerDumpPath: string, tempDb: string): Promise<void> => {
  log(`Restore dump into temp database ${tempDb}`)
  const restore = await $.nothrow()`docker compose exec -T -e PGPASSWORD='${escapeShell(env.DB_PASS)}' db pg_restore -U ${env.DB_USER} -d ${tempDb} --no-owner --no-privileges ${containerDumpPath}`
  if (restore.exitCode !== 0) fail('pg_restore into temp DB failed')
}

const runPsql = async (db: string, sql: string): Promise<string> => {
  // Pipe SQL via stdin using a single-quoted heredoc to avoid shell escaping issues
  const cmd = `docker compose exec -T -e PGPASSWORD='${escapeShell(env.DB_PASS)}' db psql -U ${env.DB_USER} -d ${db} -v ON_ERROR_STOP=1 -At <<'__SQL__'\n${sql}\n__SQL__`
  const res = await $.nothrow()`bash -lc ${cmd}`
  if (res.exitCode !== 0) fail(`psql failed: ${sql}`)
  return res.text().trim()
}

const setupFdw = async (localDb: string, tempDb: string): Promise<void> => {
  log('Setup postgres_fdw and foreign schema import')
  const host = '127.0.0.1'
  const port = String(env.POSTGRES_PORT || '5432')
  await runPsql(localDb, 'CREATE EXTENSION IF NOT EXISTS postgres_fdw;')
  await runPsql(localDb, 'DROP SERVER IF EXISTS temp_merge CASCADE;')
  await runPsql(
    localDb,
    `CREATE SERVER temp_merge FOREIGN DATA WRAPPER postgres_fdw OPTIONS (host '${host}', port '${port}', dbname '${tempDb}');`,
  )
  await runPsql(
    localDb,
    `CREATE USER MAPPING FOR ${env.DB_USER} SERVER temp_merge OPTIONS (user '${env.DB_USER}', password '${escapeShell(env.DB_PASS)}');`,
  )
  await runPsql(localDb, 'DROP SCHEMA IF EXISTS import_tmp CASCADE;')
  await runPsql(localDb, 'CREATE SCHEMA import_tmp;')
  await runPsql(localDb, 'IMPORT FOREIGN SCHEMA public FROM SERVER temp_merge INTO import_tmp;')
}

const listLocalTables = async (db: string): Promise<string[]> => {
  const out = await runPsql(
    db,
    `SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE' ORDER BY table_name;`,
  )
  return out ? out.split('\n').filter(Boolean) : []
}

const listImportedTables = async (db: string): Promise<string[]> => {
  const out = await runPsql(
    db,
    `SELECT foreign_table_name FROM information_schema.foreign_tables WHERE foreign_table_schema='import_tmp' ORDER BY foreign_table_name;`,
  )
  return out ? out.split('\n').filter(Boolean) : []
}

const getTableMeta = async (db: string, table: string): Promise<TableMeta> => {
  const pkeysRaw = await runPsql(
    db,
    `SELECT a.attname
     FROM pg_index i
     JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
     WHERE i.indrelid = 'public.${table}'::regclass AND i.indisprimary
     ORDER BY a.attnum;`,
  )
  const colsRaw = await runPsql(
    db,
    `SELECT column_name
     FROM information_schema.columns
     WHERE table_schema='public' AND table_name='${table}'
     ORDER BY ordinal_position;`,
  )
  const updatableRaw = await runPsql(
    db,
    `SELECT column_name
     FROM information_schema.columns
     WHERE table_schema='public' AND table_name='${table}'
       AND is_generated='NEVER' AND (identity_generation IS NULL)
     ORDER BY ordinal_position;`,
  )
  const pkeys = pkeysRaw ? pkeysRaw.split('\n').filter(Boolean) : []
  const cols = colsRaw ? colsRaw.split('\n').filter(Boolean) : []
  const updatable = updatableRaw ? updatableRaw.split('\n').filter(Boolean) : []
  return {table, pkeys, cols, updatable}
}

const countMissingKeys = async (db: string, table: string, pkeys: string[]): Promise<number> => {
  const on = pkeys.map((c) => `t."${c}" = p."${c}"`).join(' AND ')
  const cond = `p."${pkeys[0]}" IS NULL`
  const sql = `SELECT COUNT(*) FROM import_tmp."${table}" t LEFT JOIN public."${table}" p ON ${on} WHERE ${cond};`
  const out = await runPsql(db, sql)
  return Number(out || '0')
}

const countMatchingKeys = async (db: string, table: string, pkeys: string[]): Promise<number> => {
  const on = pkeys.map((c) => `t."${c}" = p."${c}"`).join(' AND ')
  const sql = `SELECT COUNT(*) FROM import_tmp."${table}" t INNER JOIN public."${table}" p ON ${on};`
  const out = await runPsql(db, sql)
  return Number(out || '0')
}

const buildUpsertSql = (meta: TableMeta): string => {
  const {table, pkeys, cols, updatable} = meta
  const colList = cols.map((c) => `"${c}"`).join(', ')
  const pkList = pkeys.map((c) => `"${c}"`).join(', ')
  const nonPkUpdates = updatable.filter((c) => !pkeys.includes(c))
  const setList = nonPkUpdates.map((c) => `"${c}" = EXCLUDED."${c}"`).join(', ')
  const whereDiff = nonPkUpdates
    .map((c) => `(public."${table}"."${c}" IS DISTINCT FROM EXCLUDED."${c}")`)
    .join(' OR ')
  const hasUpdates = setList.length > 0
  const updateClause = hasUpdates
    ? `DO UPDATE SET ${setList}${whereDiff ? ` WHERE ${whereDiff}` : ''}`
    : 'DO NOTHING'
  return `INSERT INTO public."${table}" (${colList})\n  SELECT ${colList} FROM import_tmp."${table}"\n  ON CONFLICT (${pkList}) ${updateClause};`
}

const adjustSequences = async (db: string, tables: string[]): Promise<void> => {
  const sql = `SELECT c.table_name, c.column_name, pg_get_serial_sequence('public.'||c.table_name, c.column_name) AS seq\n  FROM information_schema.columns c\n  WHERE c.table_schema='public' AND (c.identity_generation IS NOT NULL OR c.column_default LIKE 'nextval(%');`
  const out = await runPsql(db, sql)
  const rows = out ? out.split('\n').map((l) => l.split('|')) : []
  const entries = rows
    .map((r) => ({table: r[0], col: r[1], seq: r[2]}))
    .filter((e) => e.table && e.col && e.seq)
    .filter((e) => tables.includes(e.table))
  const apply = async (i: number): Promise<void> => {
    if (i >= entries.length) return
    const e = entries[i]
    log(`Adjust sequence for ${e.table}.${e.col}`)
    const set = `SELECT setval('${e.seq}', COALESCE((SELECT MAX("${e.col}") FROM public."${e.table}"), 0), true);`
    await runPsql(db, set)
    return apply(i + 1)
  }
  await apply(0)
}

const cleanup = async (localDb: string, tempDb: string, containerDumpPath: string): Promise<void> => {
  log('Cleanup foreign schema and server')
  await runPsql(localDb, 'DROP SCHEMA IF EXISTS import_tmp CASCADE;')
  await runPsql(localDb, 'DROP SERVER IF EXISTS temp_merge CASCADE;')
  log('Drop temp database')
  await $.nothrow()`docker compose exec -T db dropdb -U ${env.DB_USER} --if-exists ${tempDb}`
  log('Remove dump from container')
  await $.nothrow()`docker compose exec -T db rm -f ${containerDumpPath}`
}

const main = async (): Promise<void> => {
  await assertLocalDbRunning()

  const localDb = env.DB_NAME
  const localBackup = await backupLocal()
  log(`Local backup created: ${localBackup}`)

  const remoteDump = await getRemoteDump()
  log(`Remote dump ready: ${remoteDump}`)
  await confirmUse(remoteDump)

  const inContainer = await copyDumpIntoContainer(remoteDump)
  const tempDb = `merge_${nowStamp()}`
  await createTempDb(tempDb)
  await restoreDumpToDb(inContainer, tempDb)
  await setupFdw(localDb, tempDb)

  const localTables = await listLocalTables(localDb)
  const importedTables = await listImportedTables(localDb)
  const mergeTables = localTables.filter((t) => importedTables.includes(t))

  log(`Tables to merge (${mergeTables.length}): ${mergeTables.join(', ')}`)

  const processTable = async (idx: number): Promise<void> => {
    if (idx >= mergeTables.length) return
    const table = mergeTables[idx]
    const meta = await getTableMeta(localDb, table)
    if (meta.pkeys.length === 0) {
      log(`Skip ${table}: no primary key`)
      return processTable(idx + 1)
    }
    const toInsert = await countMissingKeys(localDb, table, meta.pkeys)
    const matching = await countMatchingKeys(localDb, table, meta.pkeys)
    log(`Plan ${table}: insert ~${toInsert}, update <=${matching}`)
    const upsertSql = buildUpsertSql(meta)
    await runPsql(localDb, 'BEGIN;')
    await runPsql(localDb, upsertSql)
    await runPsql(localDb, 'COMMIT;')
    return processTable(idx + 1)
  }

  await processTable(0)

  await adjustSequences(localDb, mergeTables)
  await cleanup(localDb, tempDb, inContainer)
  log('Merge complete')
}

void main()
