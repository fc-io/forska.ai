import {$} from 'bun'
import {mkdirSync} from 'fs'

const log = (s: string): void => {
  console.log(`[dbPush] ${s}`)
}

const fail = (s: string): never => {
  console.error(`[dbPush] ${s}`)
  process.exit(1)
}

const hasArg = (k: string): boolean => {
  return process.argv.includes(k)
}

const requireEnv = (k: string): string => {
  const v = process.env[k]
  return v && v.length > 0 ? v : fail(`Missing env ${k}`)
}

const nowStamp = (): string => {
  const d = new Date()
  const z = (n: number): string => {
    return n < 10 ? `0${n}` : `${n}`
  }
  return `${d.getFullYear()}${z(d.getMonth() + 1)}${z(d.getDate())}_${z(d.getHours())}${z(d.getMinutes())}${z(d.getSeconds())}`
}

const parseDbUrl = (url?: string): {host: string; port: string; user: string; pass: string; db: string} => {
  if (!url) return {host: '127.0.0.1', port: '5432', user: 'postgres', pass: '', db: 'postgres'}
  const u = new URL(url)
  const host = u.hostname || '127.0.0.1'
  const port = u.port || '5432'
  const user = decodeURIComponent(u.username || 'postgres')
  const pass = decodeURIComponent(u.password || '')
  const db = (u.pathname || '/postgres').replace(/^\//, '') || 'postgres'
  return {host, port, user, pass, db}
}

const assertLocalDbRunning = async (): Promise<void> => {
  const id = (await $.nothrow()`docker compose ps -q db`.text()).trim()
  if (!id) fail('Local db container not found. Start it: docker compose up -d db')
  const running = (await $.nothrow()`docker inspect -f {{.State.Running}} ${id}`.text()).trim()
  if (running !== 'true') fail('Local db is not running. Start it: docker compose up -d db')
}

const main = async (): Promise<void> => {
  if (!hasArg('--force')) fail('Refusing to push without --force (destructive on remote)')

  await assertLocalDbRunning()

  const sshAlias = requireEnv('SSH_ALIAS')
  const stackRoot = requireEnv('STACK_ROOT')
  const remoteUrl = process.env.REMOTE_DATABASE_URL
  const doRestore = hasArg('--restore') || (!!remoteUrl && !hasArg('--no-restore') && !hasArg('--push-only'))
  const pgToolsImage = process.env.PG_TOOLS_IMAGE || 'postgres:18'

  mkdirSync('backups', {recursive: true})
  await $.nothrow()`ssh ${sshAlias} mkdir -p ${stackRoot}/backups`

  const local = parseDbUrl(process.env.DATABASE_URL)
  const dbNameForFile = doRestore ? parseDbUrl(remoteUrl).db : local.db
  const localDump = `backups/dump_local_${dbNameForFile}_${nowStamp()}.dump`

  log('Creating local dump via docker compose (pg_dump)')
  const redir = `> ${localDump}`
  const dumpCmd = `docker compose exec -e PGPASSWORD='${local.pass.replace(/'/g, "'\\''")}' -T db pg_dump -U ${local.user} -d ${local.db} -Fc -Z 9 ${redir}`
  const dump = await $.nothrow()`bash -lc ${dumpCmd}`
  if (dump.exitCode !== 0) fail('local pg_dump failed')

  log('Copying local dump to remote backups/')
  const push = await $.nothrow()`scp ${localDump} ${sshAlias}:${stackRoot}/backups/`
  if (push.exitCode !== 0) fail('scp failed')

  if (!doRestore) {
    log('Pushed dump to remote. Skipping restore (no REMOTE_DATABASE_URL or --no-restore/--push-only).')
    log('Done')
    return
  }

  const remote = parseDbUrl(remoteUrl)
  const fname = localDump.split('/').pop() as string
  const remoteDump = `${stackRoot}/backups/${fname}`

  log('Restoring on remote via Apptainer (pg_restore)')
  const restore =
    await $.nothrow()`ssh ${sshAlias} apptainer exec --env PGPASSWORD=${remote.pass} docker://${pgToolsImage} pg_restore -h ${remote.host} -p ${remote.port} -U ${remote.user} -d ${remote.db} --clean --if-exists --no-owner --no-privileges --single-transaction ${remoteDump}`
  if (restore.exitCode !== 0) fail('remote pg_restore failed')

  log('Done')
}

void main()
