import {$} from 'bun'
import {env} from './env.ts'

type TableMeta = {table: string; pkeys: string[]; cols: string[]; updatable: string[]}

const log = (s: string): void => {
  console.log(`[dbSync] ${s}`)
}

const fail = (s: string): never => {
  console.error(`[dbSync] ${s}`)
  process.exit(1)
}

const escapeShell = (s: string): string => s.replace(/'/g, "'\\''")
const escapeSql = (s: string): string => s.replace(/'/g, "''")
const hasArg = (k: string): boolean => process.argv.includes(k)
const getArg = (k: string): string | undefined => {
  const pref = `${k}=`
  const exact = process.argv.find((a) => a.startsWith(pref))
  return exact ? exact.slice(pref.length) : undefined
}

const parseDbUrl = (url?: string): {host: string; port: string; user: string; pass: string; db: string} => {
  const defaults = {
    host: '127.0.0.1',
    port: String(env.POSTGRES_PORT ?? '5432'),
    user: env.DB_USER || 'postgres',
    pass: env.DB_PASS || '',
    db: env.DB_NAME || 'postgres',
  }
  const u = url ? new URL(url) : undefined
  const host = u?.hostname || defaults.host
  const port = u?.port || defaults.port
  const user = decodeURIComponent(u?.username || defaults.user)
  const pass = decodeURIComponent(u?.password || defaults.pass)
  const db = (u?.pathname || `/${defaults.db}`).replace(/^\//, '') || defaults.db
  return {host, port, user, pass, db}
}

const assertLocalDbRunning = async (): Promise<void> => {
  const id = (await $.nothrow()`docker compose ps -q db`.text()).trim()
  if (!id) fail('Local db container not found. Start it: docker compose up -d db')
  const running = (await $.nothrow()`docker inspect -f {{.State.Running}} ${id}`.text()).trim()
  if (running !== 'true') fail('Local db is not running. Start it: docker compose up -d db')
}

const runPsql = async (db: string, sql: string): Promise<string> => {
  const cmd = `docker compose exec -T -e PGPASSWORD='${escapeShell(env.DB_PASS)}' db psql -U ${env.DB_USER} -d ${db} -v ON_ERROR_STOP=1 -At <<'__SQL__'\n${sql}\n__SQL__`
  const res = await $.nothrow()`bash -lc ${cmd}`
  if (res.exitCode !== 0) fail(`psql failed: ${sql}`)
  return res.text().trim()
}

const ensureLocalSchemaReady = async (db: string): Promise<void> => {
  const out = await runPsql(
    db,
    `SELECT 1 FROM pg_namespace WHERE nspname='public' LIMIT 1;`,
  )
  if (!out) fail("Local DB schema missing. Run 'bun run db:mig' (and 'bun run db:ba-mig' if needed) before syncing.")
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
    `SELECT foreign_table_name FROM information_schema.foreign_tables WHERE foreign_table_schema='import_remote' ORDER BY foreign_table_name;`,
  )
  return out ? out.split('\n').filter(Boolean) : []
}

const getForeignKeyEdges = async (db: string): Promise<Array<{table: string; referencedTable: string}>> => {
  const sql = `
    SELECT tc.table_name AS table, ccu.table_name AS referenced_table
    FROM information_schema.table_constraints AS tc
    JOIN information_schema.key_column_usage AS kcu
      ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
    JOIN information_schema.constraint_column_usage AS ccu
      ON ccu.constraint_name = tc.constraint_name AND ccu.table_schema = tc.table_schema
    WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = 'public'
    ORDER BY 1, 2;`
  const out = await runPsql(db, sql)
  if (!out) return []
  return out
    .split('\n')
    .filter(Boolean)
    .map((l) => l.split('|'))
    .filter((parts): parts is [string, string] => parts.length >= 2 && parts[0] !== undefined && parts[1] !== undefined)
    .map(([table, referencedTable]) => ({table, referencedTable}))
}

const topoSortTables = (tables: string[], edges: Array<{table: string; referencedTable: string}>): string[] => {
  const set = new Set(tables)
  const adj = new Map<string, Set<string>>()
  const indeg = new Map<string, number>()
  for (const t of tables) {
    adj.set(t, new Set())
    indeg.set(t, 0)
  }
  for (const e of edges) {
    if (!set.has(e.table) || !set.has(e.referencedTable)) continue
    if (!adj.get(e.referencedTable)!.has(e.table)) {
      adj.get(e.referencedTable)!.add(e.table)
      indeg.set(e.table, (indeg.get(e.table) || 0) + 1)
    }
  }
  const queue: string[] = []
  for (const [t, d] of indeg.entries()) if (d === 0) queue.push(t)
  const out: string[] = []
  const step = (): string[] => {
    return queue.length
      ? (() => {
          const n = queue.shift() as string
          out.push(n)
          for (const m of adj.get(n) || []) {
            const d = (indeg.get(m) || 0) - 1
            indeg.set(m, d)
            if (d === 0) queue.push(m)
          }
          return step()
        })()
      : out
  }
  const res = step()
  return res.length !== tables.length ? [...res, ...tables.filter((t) => !res.includes(t))] : res
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
  const importColsRaw = await runPsql(
    db,
    `SELECT column_name
     FROM information_schema.columns
     WHERE table_schema='import_remote' AND table_name='${table}'
     ORDER BY ordinal_position;`,
  )
  const pkeys = pkeysRaw ? pkeysRaw.split('\n').filter(Boolean) : []
  const localCols = colsRaw ? colsRaw.split('\n').filter(Boolean) : []
  const importCols = importColsRaw ? importColsRaw.split('\n').filter(Boolean) : []
  const updatable = updatableRaw ? updatableRaw.split('\n').filter(Boolean) : []
  const commonCols = localCols.filter((c) => importCols.includes(c))
  const commonUpdatable = updatable.filter((c) => importCols.includes(c))
  return {table, pkeys, cols: commonCols, updatable: commonUpdatable}
}

const buildUpsertSql = (meta: TableMeta, where: string | undefined): string => {
  const {table, pkeys, cols, updatable} = meta
  const colList = cols.map((c) => `"${c}"`).join(', ')
  const pkList = pkeys.map((c) => `"${c}"`).join(', ')
  const nonPkUpdates = updatable.filter((c) => !pkeys.includes(c))
  const setList = nonPkUpdates.map((c) => `"${c}" = EXCLUDED."${c}"`).join(', ')
  const whereDiff = nonPkUpdates.map((c) => `(public."${table}"."${c}" IS DISTINCT FROM EXCLUDED."${c}")`).join(' OR ')
  const updateClause = setList.length > 0 ? `DO UPDATE SET ${setList}${whereDiff ? ` WHERE ${whereDiff}` : ''}` : 'DO NOTHING'
  const filter = where ? ` WHERE ${where}` : ''
  return `INSERT INTO public."${table}" (${colList})\n  SELECT ${colList} FROM import_remote."${table}" t${filter}\n  ON CONFLICT (${pkList}) ${updateClause};`
}

const ensureSyncState = async (db: string): Promise<void> => {
  await runPsql(
    db,
    `CREATE TABLE IF NOT EXISTS public.sync_state (
       remote_id text NOT NULL,
       table_name text NOT NULL,
       last_synced_at timestamptz NOT NULL DEFAULT to_timestamp(0),
       PRIMARY KEY (remote_id, table_name)
     );`,
  )
}

const getLastSyncedAt = async (db: string, remoteId: string, table: string): Promise<string> => {
  const out = await runPsql(
    db,
    `SELECT last_synced_at FROM public.sync_state WHERE remote_id='${escapeSql(remoteId)}' AND table_name='${escapeSql(table)}' LIMIT 1;`,
  )
  return out || '1970-01-01T00:00:00Z'
}

const updateSyncState = async (db: string, remoteId: string, table: string, iso: string): Promise<void> => {
  await runPsql(
    db,
    `INSERT INTO public.sync_state(remote_id, table_name, last_synced_at)
     VALUES ('${escapeSql(remoteId)}','${escapeSql(table)}','${escapeSql(iso)}')
     ON CONFLICT (remote_id, table_name)
     DO UPDATE SET last_synced_at = GREATEST(EXCLUDED.last_synced_at, sync_state.last_synced_at);`,
  )
}

const setupFdw = async (localDb: string, remote: {host: string; port: string; user: string; pass: string; db: string}): Promise<void> => {
  const isLocal = remote.host === '127.0.0.1' || remote.host === 'localhost'
  const fdwHost = process.env.REMOTE_FDW_HOST || (isLocal ? 'host.docker.internal' : remote.host)
  log(`FDW target ${fdwHost}:${remote.port}/${remote.db}`)
  await runPsql(localDb, 'CREATE EXTENSION IF NOT EXISTS postgres_fdw;')
  await runPsql(localDb, 'DROP SERVER IF EXISTS sync_remote CASCADE;')
  await runPsql(
    localDb,
    `CREATE SERVER sync_remote FOREIGN DATA WRAPPER postgres_fdw OPTIONS (host '${escapeSql(fdwHost)}', port '${escapeSql(remote.port)}', dbname '${escapeSql(remote.db)}');`,
  )
  await runPsql(
    localDb,
    `CREATE USER MAPPING FOR ${env.DB_USER} SERVER sync_remote OPTIONS (user '${escapeSql(remote.user)}', password '${escapeSql(remote.pass)}');`,
  )
  await runPsql(localDb, 'DROP SCHEMA IF EXISTS import_remote CASCADE;')
  await runPsql(localDb, 'CREATE SCHEMA import_remote;')
  await runPsql(localDb, 'IMPORT FOREIGN SCHEMA public FROM SERVER sync_remote INTO import_remote;')
}

const adjustSequences = async (db: string, tables: string[]): Promise<void> => {
  const sql = `SELECT c.table_name, c.column_name, pg_get_serial_sequence('public.'||c.table_name, c.column_name) AS seq\n  FROM information_schema.columns c\n  WHERE c.table_schema='public' AND (c.identity_generation IS NOT NULL OR c.column_default LIKE 'nextval(%');`
  const out = await runPsql(db, sql)
  const rows = out ? out.split('\n').map((l) => l.split('|')) : []
  const entries = rows
    .map((r) => ({table: r[0], col: r[1], seq: r[2]}))
    .filter((e): e is {table: string; col: string; seq: string} => Boolean(e.table) && Boolean(e.col) && Boolean(e.seq))
    .filter((e) => tables.includes(e.table))
  const step = async (i: number): Promise<void> => {
    const e = entries[i]
    if (!e) return
    log(`Adjust sequence for ${e.table}.${e.col}`)
    const set = `SELECT setval('${e.seq}', COALESCE((SELECT MAX("${e.col}") FROM public."${e.table}"), 0), true);`
    await runPsql(db, set)
    return step(i + 1)
  }
  await step(0)
}

const cleanup = async (localDb: string): Promise<void> => {
  await runPsql(localDb, 'DROP SCHEMA IF EXISTS import_remote CASCADE;')
  await runPsql(localDb, 'DROP SERVER IF EXISTS sync_remote CASCADE;')
}

const main = async (): Promise<void> => {
  await assertLocalDbRunning()
  await ensureLocalSchemaReady(env.DB_NAME)

  const remoteUrl = env.REMOTE_DATABASE_URL
  if (!remoteUrl) fail('REMOTE_DATABASE_URL is not set; set it to the SSH-tunneled connection (e.g., postgres://user:pass@localhost:8432/db)')
  const remote = parseDbUrl(remoteUrl)
  const remoteId = process.env.REMOTE_ID || `${remote.host}:${remote.port}/${remote.db}`
  const fullSync = hasArg('--full')
  const onlyTablesCsv = getArg('--tables') || ''
  const onlyTables = onlyTablesCsv
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)

  await ensureSyncState(env.DB_NAME)
  await setupFdw(env.DB_NAME, remote)

  const localTables = await listLocalTables(env.DB_NAME)
  const importedTables = await listImportedTables(env.DB_NAME)
  const all = localTables.filter((t) => importedTables.includes(t))
  const picked = onlyTables.length > 0 ? all.filter((t) => onlyTables.includes(t)) : all

  const fkEdges = await getForeignKeyEdges(env.DB_NAME)
  const mergeTables = topoSortTables(picked, fkEdges)
  log(`Tables to sync (${mergeTables.length}): ${mergeTables.join(', ')}`)

  const processTable = async (idx: number): Promise<void> => {
    const table = mergeTables[idx]
    if (!table) return
    const meta = await getTableMeta(env.DB_NAME, table)
    if (meta.pkeys.length === 0) {
      log(`Skip ${table}: no primary key`)
      return processTable(idx + 1)
    }
    const hasUpdatedAt = meta.cols.includes('updated_at')
    const last = fullSync || !hasUpdatedAt ? undefined : await getLastSyncedAt(env.DB_NAME, remoteId, table)
    const where = fullSync || !hasUpdatedAt || !last ? undefined : `t."updated_at" > '${escapeSql(last)}'::timestamptz`
    log(`Sync ${table} ${where ? `(delta since ${last})` : '(full upsert)'}`)
    await runPsql(env.DB_NAME, 'BEGIN;')
    await runPsql(env.DB_NAME, buildUpsertSql(meta, where))
    await runPsql(env.DB_NAME, 'COMMIT;')
    if (hasUpdatedAt && !fullSync && last) {
      const max = await runPsql(
        env.DB_NAME,
        `SELECT COALESCE(MAX(updated_at), '${escapeSql(last)}'::timestamptz) FROM import_remote."${table}";`,
      )
      await updateSyncState(env.DB_NAME, remoteId, table, max || last || '1970-01-01T00:00:00Z')
    }
    return processTable(idx + 1)
  }

  await processTable(0)
  await adjustSequences(env.DB_NAME, mergeTables)
  await cleanup(env.DB_NAME)
  log('Sync complete')
}

void main()
