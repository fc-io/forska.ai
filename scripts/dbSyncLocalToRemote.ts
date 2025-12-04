import {$} from 'bun'

import {env} from './env.ts'

type TableMeta = {table: string; pkeys: string[]; cols: string[]; updatable: string[]}

const log = (s: string): void => {
  console.log(`[dbSyncLocalToRemote] ${s}`)
}

const fail = (s: string): never => {
  console.error(`[dbSyncLocalToRemote] ${s}`)
  process.exit(1)
}

const escapeShell = (s: string): string => {
  return s.replace(/'/g, "'\\''")
}
const escapeSql = (s: string): string => {
  return s.replace(/'/g, "''")
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
  const cmd = `docker compose exec -T -e PGPASSWORD='${escapeShell(env.DB_PASS || '')}' db psql -U ${env.DB_USER} -d ${db} -v ON_ERROR_STOP=1 -At <<'__SQL__'\n${sql}\n__SQL__`
  const res = await $.nothrow()`bash -lc ${cmd}`
  if (res.exitCode !== 0) fail(`psql failed: ${sql}`)
  return res.text().trim()
}

const runRemoteMigrations = async (remoteUrl: string): Promise<void> => {
  log('Running migrations on remote...')
  // We use drizzle-kit migrate with the remote URL
  const res = await $.nothrow()`DATABASE_URL=${remoteUrl} bunx drizzle-kit migrate`
  if (res.exitCode !== 0) fail('Remote migration failed')
  log('Remote migrations applied successfully.')
}

const setupFdw = async (
  localDb: string,
  remote: {host: string; port: string; user: string; pass: string; db: string},
): Promise<void> => {
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
    .map((l) => {
      const parts = l.split('|')
      if (parts.length < 2) return null
      return {table: parts[0], referencedTable: parts[1]}
    })
    .filter((x): x is {table: string; referencedTable: string} => {
      return x !== null
    })
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
    const refSet = adj.get(e.referencedTable)
    if (refSet && !refSet.has(e.table)) {
      refSet.add(e.table)
      indeg.set(e.table, (indeg.get(e.table) || 0) + 1)
    }
  }
  const queue: string[] = []
  for (const [t, d] of indeg.entries()) {
    if (d === 0) queue.push(t)
  }
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
  return res.length !== tables.length
    ? [
        ...res,
        ...tables.filter((t) => {
          return !res.includes(t)
        }),
      ]
    : res
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
  const commonCols = localCols.filter((c) => {
    return importCols.includes(c)
  })
  const commonUpdatable = updatable.filter((c) => {
    return importCols.includes(c)
  })
  return {table, pkeys, cols: commonCols, updatable: commonUpdatable}
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

const ensureSyncState = async (db: string): Promise<void> => {
  await runPsql(
    db,
    `CREATE TABLE IF NOT EXISTS public.sync_state_local_to_remote (
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
    `SELECT last_synced_at FROM public.sync_state_local_to_remote WHERE remote_id='${escapeSql(remoteId)}' AND table_name='${escapeSql(table)}' LIMIT 1;`,
  )
  return out || '1970-01-01T00:00:00Z'
}

const updateSyncState = async (db: string, remoteId: string, table: string, iso: string): Promise<void> => {
  await runPsql(
    db,
    `INSERT INTO public.sync_state_local_to_remote(remote_id, table_name, last_synced_at)
     VALUES ('${escapeSql(remoteId)}','${escapeSql(table)}','${escapeSql(iso)}')
     ON CONFLICT (remote_id, table_name)
     DO UPDATE SET last_synced_at = GREATEST(EXCLUDED.last_synced_at, sync_state_local_to_remote.last_synced_at);`,
  )
}

const syncTableData = async (db: string, meta: TableMeta, remoteId: string, fullSync: boolean): Promise<void> => {
  const {table, pkeys, cols, updatable} = meta
  if (pkeys.length === 0) {
    log(`Skip ${table}: no primary key`)
    return
  }

  const hasUpdatedAt = cols.includes('updated_at')
  const last = fullSync || !hasUpdatedAt ? undefined : await getLastSyncedAt(db, remoteId, table)
  // For Local -> Remote, we filter LOCAL rows that are newer than the last sync
  const whereTime =
    fullSync || !hasUpdatedAt || !last ? undefined : `l."updated_at" > '${escapeSql(last)}'::timestamptz`

  log(`Sync ${table} ${whereTime ? `(delta since ${last})` : '(full scan)'}`)

  const pkMatch = pkeys
    .map((k) => {
      return `r."${k}" = l."${k}"`
    })
    .join(' AND ')
  const nonPkUpdates = updatable.filter((c) => {
    return !pkeys.includes(c)
  })

  // 1. UPDATE existing rows on remote that differ
  // If delta mode, we only look at local rows that have changed recently
  if (nonPkUpdates.length > 0) {
    const setList = nonPkUpdates
      .map((c) => {
        return `"${c}" = l."${c}"`
      })
      .join(', ')
    const whereDiff = nonPkUpdates
      .map((c) => {
        return `(r."${c}" IS DISTINCT FROM l."${c}")`
      })
      .join(' OR ')

    const updateSql = `
      UPDATE import_remote."${table}" r
      SET ${setList}
      FROM public."${table}" l
      WHERE ${pkMatch} AND (${whereDiff})
      ${whereTime ? `AND ${whereTime}` : ''};
    `
    log(`Updating changed rows in ${table}...`)
    await runPsql(db, updateSql)
  }

  // 2. INSERT new rows from local to remote
  const colList = cols
    .map((c) => {
      return `"${c}"`
    })
    .join(', ')
  const insertSql = `
    INSERT INTO import_remote."${table}" (${colList})
    SELECT ${colList}
    FROM public."${table}" l
    WHERE NOT EXISTS (
      SELECT 1 FROM import_remote."${table}" r WHERE ${pkMatch}
    )
    ${whereTime ? `AND ${whereTime}` : ''};
  `
  log(`Inserting new rows into ${table}...`)
  await runPsql(db, insertSql)

  // Update watermark if we used delta sync
  if (hasUpdatedAt && !fullSync && last) {
    // We need the max updated_at from the LOCAL table (for the rows we just considered)
    // Actually, simply taking the max updated_at from the whole local table is safe enough
    // because we have now pushed everything up to that point.
    const max = await runPsql(
      db,
      `SELECT COALESCE(MAX(updated_at), '${escapeSql(last)}'::timestamptz) FROM public."${table}";`,
    )
    await updateSyncState(db, remoteId, table, max || last || '1970-01-01T00:00:00Z')
  }
}

const adjustRemoteSequences = async (db: string, tables: string[]): Promise<void> => {
  // We need to run this on the REMOTE db, but we can do it via FDW if we wrap it in a function or just exec via psql on local?
  // Actually, we can't easily run arbitrary SQL on remote via FDW without a function.
  // But we have the remote connection details, so we can just use runPsql but target the remote?
  // Wait, runPsql uses `docker compose exec db psql ...` which connects to LOCAL db.
  // To run on remote, we need to connect to it.
  // Since we have an SSH tunnel, we can connect to it from the host using `psql` if installed, or from the `db` container using the FDW connection string?
  // Easier: Use the `db` container to connect to the remote host (host.docker.internal) using psql.

  // Let's find sequences on LOCAL first to know what to update.
  const sql = `SELECT c.table_name, c.column_name, pg_get_serial_sequence('public.'||c.table_name, c.column_name) AS seq\n  FROM information_schema.columns c\n  WHERE c.table_schema='public' AND (c.identity_generation IS NOT NULL OR c.column_default LIKE 'nextval(%');`
  const out = await runPsql(db, sql)
  const rows = out
    ? out.split('\n').map((l) => {
        return l.split('|')
      })
    : []
  const entries = rows
    .map((r) => {
      return {table: r[0], col: r[1], seq: r[2]}
    })
    .filter((e) => {
      return e.table && e.col && e.seq
    })
    .filter((e) => {
      return tables.includes(e.table)
    })

  if (entries.length === 0) return

  const remoteUrl = env.REMOTE_DATABASE_URL
  if (!remoteUrl) fail('REMOTE_DATABASE_URL is not set')
  const remote = parseDbUrl(remoteUrl)
  const isLocal = remote.host === '127.0.0.1' || remote.host === 'localhost'
  const targetHost = isLocal ? 'host.docker.internal' : remote.host

  log('Adjusting sequences on remote...')

  // We will construct a big SQL block to run on the remote
  let remoteSql = ''
  for (const e of entries) {
    // We need the MAX value from the REMOTE table (which is now synced)
    // Actually, we can just set it to the MAX of the table.
    remoteSql += `SELECT setval('${e.seq}', COALESCE((SELECT MAX("${e.col}") FROM public."${e.table}"), 0), true);\n`
  }

  // Execute on remote
  // We use the local 'db' container to run psql connecting to the remote
  const cmd = `docker compose exec -T -e PGPASSWORD='${escapeShell(remote.pass)}' db psql -h ${targetHost} -p ${remote.port} -U ${remote.user} -d ${remote.db} -v ON_ERROR_STOP=1 -At <<'__SQL__'\n${remoteSql}\n__SQL__`
  const res = await $.nothrow()`bash -lc ${cmd}`
  if (res.exitCode !== 0) {
    console.error(res.stderr)
    fail('Failed to adjust sequences on remote')
  }
}

const cleanup = async (localDb: string): Promise<void> => {
  await runPsql(localDb, 'DROP SCHEMA IF EXISTS import_remote CASCADE;')
  await runPsql(localDb, 'DROP SERVER IF EXISTS sync_remote CASCADE;')
}

const main = async (): Promise<void> => {
  await assertLocalDbRunning()

  const remoteUrl = env.REMOTE_DATABASE_URL
  if (!remoteUrl) fail('REMOTE_DATABASE_URL is not set')

  const remote = parseDbUrl(remoteUrl)
  const remoteId = process.env.REMOTE_ID || `${remote.host}:${remote.port}/${remote.db}`
  const fullSync = process.argv.includes('--full')

  // 1. Run Migrations on Remote
  await runRemoteMigrations(remoteUrl)

  // 2. Setup FDW for Data Sync
  await setupFdw(env.DB_NAME, remote)
  await ensureSyncState(env.DB_NAME)

  const localTables = await listLocalTables(env.DB_NAME)
  const importedTables = await listImportedTables(env.DB_NAME)
  const commonTables = localTables.filter((t) => {
    return importedTables.includes(t)
  })

  const fkEdges = await getForeignKeyEdges(env.DB_NAME)
  const sortedTables = topoSortTables(commonTables, fkEdges)

  log(`Tables to sync (${sortedTables.length}): ${sortedTables.join(', ')}`)

  // 3. Sync Data (Update + Insert)
  for (const table of sortedTables) {
    const meta = await getTableMeta(env.DB_NAME, table)
    await syncTableData(env.DB_NAME, meta, remoteId, fullSync)
  }

  // 4. Adjust Sequences
  await adjustRemoteSequences(env.DB_NAME, sortedTables)

  // 5. Cleanup
  await cleanup(env.DB_NAME)

  log('Sync Local -> Remote complete')
}

void main()
