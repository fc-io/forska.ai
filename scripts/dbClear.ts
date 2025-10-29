import {$} from 'bun'

import {env} from './env.ts'

const log = (s: string): void => {
  console.log(`[dbClear] ${s}`)
}

const fail = (s: string): never => {
  console.error(`[dbClear] ${s}`)
  process.exit(1)
}

const hasArg = (k: string): boolean => {
  return process.argv.includes(k)
}

const assertLocalDbRunning = async (): Promise<void> => {
  const id = (await $.nothrow()`docker compose ps -q db`.text()).trim()
  if (!id) fail('Local db container not found. Start it: docker compose up -d db')
  const running = (await $.nothrow()`docker inspect -f {{.State.Running}} ${id}`.text()).trim()
  if (running !== 'true') fail('Local db is not running. Start it: docker compose up -d db')
}

const getDbVars = (): {user: string; pass: string; db: string} => {
  const user = env.DB_USER || 'postgres'
  const pass = env.DB_PASS || ''
  const db = env.DB_NAME || 'postgres'
  return {user, pass, db}
}

const runPsql = async (sql: string): Promise<number> => {
  const {user, pass, db} = getDbVars()
  const pw = pass.replace(/'/g, "'\\''")
  const cmd = `docker compose exec -e PGPASSWORD='${pw}' -T db psql -v ON_ERROR_STOP=1 -U ${user} -d ${db} -c "${sql}"`
  const res = await $.nothrow()`bash -lc ${cmd}`
  return res.exitCode ?? 1
}

const getTruncateSQL = async (): Promise<string> => {
  const {user, pass, db} = getDbVars()
  const pw = pass.replace(/'/g, "'\\''")
  const query =
    "SELECT 'TRUNCATE TABLE ' || string_agg(format('%I.%I', schemaname, tablename), ', ') || ' RESTART IDENTITY CASCADE;' FROM pg_tables WHERE schemaname = 'public'"
  const cmd = `docker compose exec -e PGPASSWORD='${pw}' -T db psql -U ${user} -d ${db} -At -c "${query}"`
  const out = await $.nothrow()`bash -lc ${cmd}`.text()
  return out.trim()
}

const main = async (): Promise<void> => {
  if (!hasArg('--force')) fail('Refusing to clear without --force (destructive)')

  await assertLocalDbRunning()

  if (hasArg('--drop') || hasArg('--reset')) {
    log('Dropping and recreating schema public (CASCADE)')
    const exit = await runPsql('DROP SCHEMA public CASCADE; CREATE SCHEMA public;')
    if (exit !== 0) fail('Failed to drop/recreate schema')
    log('Done')
    return
  }

  log('Generating TRUNCATE statement for all tables in schema public')
  const truncateSQL = await getTruncateSQL()
  if (!truncateSQL || /^\s*TRUNCATE TABLE\s*;?\s*$/.test(truncateSQL)) {
    log('No tables found or nothing to truncate')
    return
  }
  log(`Executing: ${truncateSQL}`)
  const exit = await runPsql(truncateSQL)
  if (exit !== 0) fail('Failed to truncate tables')
  log('Done')
}

void main()

