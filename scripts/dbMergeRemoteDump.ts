import {stdin as input, stdout as output} from 'node:process'
import readline from 'node:readline/promises'

import {$} from 'bun'
import {mkdirSync, readdirSync, statSync} from 'fs'
import {basename} from 'path'

import {env} from './env.ts'

type TableMeta = {table: string; pkeys: string[]; cols: string[]; updatable: string[]}

const log = (s: string): void => {
  console.log(`[dbMerge] ${s}`)
}

const fail = (s: string): never => {
  console.error(`[dbMerge] ${s}`)
  process.exit(1)
}

const nowStamp = (): string => {
  const d = new Date()
  const p = (n: number): string => {
    return n < 10 ? `0${n}` : `${n}`
  }
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

const latestFileMatching = (dir: string, prefix: string): string | undefined => {
  const files = readdirSync(dir).filter((f) => {
    return f.startsWith(prefix)
  })
  const dated = files.map((f) => {
    return {f, mtime: statSync(`${dir}/${f}`).mtimeMs}
  })
  const sorted = dated.sort((a, b) => {
    return b.mtime - a.mtime
  })
  return sorted[0]?.f ? `${dir}/${sorted[0].f}` : undefined
}

const assertLocalDbRunning = async (): Promise<void> => {
  const id = (await $.nothrow()`docker compose ps -q db`.text()).trim()
  if (!id) fail('Local db container not found. Start it: docker compose up -d db')
  const running = (await $.nothrow()`docker inspect -f {{.State.Running}} ${id}`.text()).trim()
  if (running !== 'true') fail('Local db is not running. Start it: docker compose up -d db')
}

const escapeShell = (s: string): string => {
  return s.replace(/'/g, "'\\''")
}
const hasArg = (a: string): boolean => {
  return process.argv.includes(a)
}
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
  const restore =
    await $.nothrow()`docker compose exec -T -e PGPASSWORD='${escapeShell(env.DB_PASS)}' db pg_restore -U ${env.DB_USER} -d ${tempDb} --no-owner --no-privileges ${containerDumpPath}`
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

const ensureLocalSchemaReady = async (db: string): Promise<void> => {
  // Check for a known required enum type created by migrations
  const out = await runPsql(
    db,
    `SELECT 1
     FROM pg_type t
     JOIN pg_namespace n ON n.oid = t.typnamespace
     WHERE n.nspname = 'public' AND t.typname = 'publication_status_enum'
     LIMIT 1;`,
  )
  if (!out) {
    fail(
      "Local DB schema missing required types (e.g., public.publication_status_enum). Run 'bun run db:mig' before merging.",
    )
  }
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

const getForeignKeyEdges = async (db: string): Promise<Array<{table: string; referencedTable: string}>> => {
  // List foreign key edges within public schema
  const sql = `
    SELECT
      tc.table_name AS table,
      ccu.table_name AS referenced_table
    FROM information_schema.table_constraints AS tc
    JOIN information_schema.key_column_usage AS kcu
      ON tc.constraint_name = kcu.constraint_name
      AND tc.table_schema = kcu.table_schema
    JOIN information_schema.constraint_column_usage AS ccu
      ON ccu.constraint_name = tc.constraint_name
      AND ccu.table_schema = tc.table_schema
    WHERE tc.constraint_type = 'FOREIGN KEY'
      AND tc.table_schema = 'public'
    ORDER BY 1, 2;`
  const out = await runPsql(db, sql)
  if (!out) return []
  return out
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      return l.split('|')
    })
    .filter((parts): parts is [string, string] => {
      return parts.length >= 2 && parts[0] !== undefined && parts[1] !== undefined
    })
    .map(([table, referencedTable]) => {
      return {table, referencedTable}
    })
}

const topoSortTables = (tables: string[], edges: Array<{table: string; referencedTable: string}>): string[] => {
  // Kahn's algorithm constrained to provided tables subset
  const set = new Set(tables)
  const adj = new Map<string, Set<string>>()
  const indeg = new Map<string, number>()
  for (const t of tables) {
    adj.set(t, new Set())
    indeg.set(t, 0)
  }
  for (const e of edges) {
    if (!set.has(e.table) || !set.has(e.referencedTable)) continue
    // Edge: referencedTable -> table (parent before child)
    if (!adj.get(e.referencedTable)!.has(e.table)) {
      adj.get(e.referencedTable)!.add(e.table)
      indeg.set(e.table, (indeg.get(e.table) || 0) + 1)
    }
  }
  const queue: string[] = []
  for (const [t, d] of indeg.entries()) if (d === 0) queue.push(t)
  const out: string[] = []
  while (queue.length) {
    const n = queue.shift()!
    out.push(n)
    for (const m of adj.get(n) || []) {
      const d = (indeg.get(m) || 0) - 1
      indeg.set(m, d)
      if (d === 0) queue.push(m)
    }
  }
  // If cycle or missing, fall back to original order appended
  if (out.length !== tables.length) {
    const missing = tables.filter((t) => {
      return !out.includes(t)
    })
    return [...out, ...missing]
  }
  return out
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

  // Get columns from the foreign (imported) table
  const importColsRaw = await runPsql(
    db,
    `SELECT column_name
     FROM information_schema.columns
     WHERE table_schema='import_tmp' AND table_name='${table}'
     ORDER BY ordinal_position;`,
  )

  const pkeys = pkeysRaw ? pkeysRaw.split('\n').filter(Boolean) : []
  const localCols = colsRaw ? colsRaw.split('\n').filter(Boolean) : []
  const importCols = importColsRaw ? importColsRaw.split('\n').filter(Boolean) : []
  const updatable = updatableRaw ? updatableRaw.split('\n').filter(Boolean) : []

  // Only use columns that exist in both local AND imported tables
  const commonCols = localCols.filter((c) => importCols.includes(c))
  const commonUpdatable = updatable.filter((c) => importCols.includes(c))

  if (commonCols.length !== localCols.length) {
    const missing = localCols.filter((c) => !importCols.includes(c))
    log(`  Schema mismatch for ${table}: local has ${missing.length} extra columns: ${missing.join(', ')}`)
  }
  if (importCols.length !== localCols.length) {
    const extra = importCols.filter((c) => !localCols.includes(c))
    if (extra.length > 0) {
      log(`  Schema mismatch for ${table}: import has ${extra.length} extra columns: ${extra.join(', ')}`)
    }
  }

  return {table, pkeys, cols: commonCols, updatable: commonUpdatable}
}

const countMissingKeys = async (db: string, table: string, pkeys: string[]): Promise<number> => {
  const on = pkeys
    .map((c) => {
      return `t."${c}" = p."${c}"`
    })
    .join(' AND ')
  const cond = `p."${pkeys[0]}" IS NULL`
  const sql = `SELECT COUNT(*) FROM import_tmp."${table}" t LEFT JOIN public."${table}" p ON ${on} WHERE ${cond};`
  const out = await runPsql(db, sql)
  return Number(out || '0')
}

const countMatchingKeys = async (db: string, table: string, pkeys: string[]): Promise<number> => {
  const on = pkeys
    .map((c) => {
      return `t."${c}" = p."${c}"`
    })
    .join(' AND ')
  const sql = `SELECT COUNT(*) FROM import_tmp."${table}" t INNER JOIN public."${table}" p ON ${on};`
  const out = await runPsql(db, sql)
  return Number(out || '0')
}

const buildUpsertSql = (meta: TableMeta): string => {
  const {table, pkeys, cols, updatable} = meta
  const colList = cols
    .map((c) => {
      return `"${c}"`
    })
    .join(', ')
  const pkList = pkeys
    .map((c) => {
      return `"${c}"`
    })
    .join(', ')
  const nonPkUpdates = updatable.filter((c) => {
    return !pkeys.includes(c)
  })
  const setList = nonPkUpdates
    .map((c) => {
      return `"${c}" = EXCLUDED."${c}"`
    })
    .join(', ')
  const whereDiff = nonPkUpdates
    .map((c) => {
      return `(public."${table}"."${c}" IS DISTINCT FROM EXCLUDED."${c}")`
    })
    .join(' OR ')
  const hasUpdates = setList.length > 0
  const updateClause = hasUpdates ? `DO UPDATE SET ${setList}${whereDiff ? ` WHERE ${whereDiff}` : ''}` : 'DO NOTHING'
  return `INSERT INTO public."${table}" (${colList})\n  SELECT ${colList} FROM import_tmp."${table}"\n  ON CONFLICT (${pkList}) ${updateClause};`
}

const adjustSequences = async (db: string, tables: string[]): Promise<void> => {
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
    .filter((e): e is {table: string; col: string; seq: string} => {
      return Boolean(e.table) && Boolean(e.col) && Boolean(e.seq)
    })
    .filter((e) => {
      return tables.includes(e.table)
    })
  const apply = async (i: number): Promise<void> => {
    const e = entries[i]
    if (!e) return
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
  await ensureLocalSchemaReady(env.DB_NAME)

  const localDb = env.DB_NAME

  // Skip backup if --no-backup flag is passed
  if (hasArg('--no-backup')) {
    log('Skipping local backup (--no-backup flag)')
  } else {
    const localBackup = await backupLocal()
    log(`Local backup created: ${localBackup}`)
  }

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
  let mergeTables = localTables.filter((t) => {
    return importedTables.includes(t)
  })

  // Order tables so parents are merged before children (respect FK deps)
  const fkEdges = await getForeignKeyEdges(localDb)
  const ordered = topoSortTables(mergeTables, fkEdges)
  if (ordered.join(',') !== mergeTables.join(',')) {
    log(`Reordered tables by FK deps`)
  }
  mergeTables = ordered

  log(`Tables to merge (${mergeTables.length}): ${mergeTables.join(', ')}`)

  const processTable = async (idx: number): Promise<void> => {
    const table = mergeTables[idx]
    if (!table) return
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
