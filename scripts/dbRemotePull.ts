import {$} from 'bun'
import {mkdirSync} from 'fs'

const log = (s: string): void => {
  console.log(`[dbRemotePull] ${s}`)
}

const fail = (s: string): never => {
  console.error(`[dbRemotePull] ${s}`)
  process.exit(1)
}

const nowStamp = (): string => {
  const d = new Date()
  const z = (n: number): string => {
    return n < 10 ? `0${n}` : `${n}`
  }
  return `${d.getFullYear()}${z(d.getMonth() + 1)}${z(d.getDate())}_${z(d.getHours())}${z(d.getMinutes())}${z(d.getSeconds())}`
}

const requireEnv = (k: string): string => {
  const v = process.env[k]
  return v && v.length > 0 ? v : fail(`Missing env ${k}`)
}

const parseDbUrl = (url?: string): {host: string; port: string; user: string; pass: string; db: string} => {
  const defaults = {
    host: '127.0.0.1',
    port: process.env.POSTGRES_PORT || '5432',
    user: process.env.DB_USER || 'postgres',
    pass: process.env.DB_PASS || '',
    db: process.env.DB_NAME || 'postgres',
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

const main = async (): Promise<void> => {
  const sshAlias = requireEnv('SSH_ALIAS')
  const stackRoot = requireEnv('STACK_ROOT')
  const remote = parseDbUrl(process.env.REMOTE_DATABASE_URL)
  mkdirSync('backups', {recursive: true})
  await $.nothrow()`ssh ${sshAlias} mkdir -p ${stackRoot}/backups`
  const remoteDump = `${stackRoot}/backups/dump_remote_${remote.db}_${nowStamp()}.dump`
  log('Creating remote dump via Apptainer (pg_dump)')
  const dump =
    await $.nothrow()`ssh ${sshAlias} apptainer exec --env PGPASSWORD=${remote.pass} docker://postgres:18 pg_dump -h ${remote.host} -p ${remote.port} -U ${remote.user} -d ${remote.db} -Fc -Z 9 -f ${remoteDump}`
  if (dump.exitCode !== 0) fail('remote pg_dump failed')
  log('Copying remote dump to local backups/')
  const pull = await $.nothrow()`scp ${sshAlias}:${remoteDump} backups/`
  if (pull.exitCode !== 0) fail('scp failed')
  const fname = remoteDump.split('/').pop() as string
  await assertLocalDbRunning()
  // Require explicit local DB credentials; do not rely on DATABASE_URL
  const localUser = requireEnv('DB_USER')
  const localPass = requireEnv('DB_PASS')
  const localDb = requireEnv('DB_NAME')
  log('Copying dump into local container and restoring')
  const cpIn = await $.nothrow()`docker compose cp backups/${fname} db:/tmp/${fname}`
  if (cpIn.exitCode !== 0) fail('docker compose cp failed')
  const restore =
    await $.nothrow()`docker compose exec -T -e PGPASSWORD=${localPass} db pg_restore -U ${localUser} -d ${localDb} --clean --if-exists --no-owner --no-privileges /tmp/${fname}`
  if (restore.exitCode !== 0) fail('pg_restore failed')
  log('Done')
}

void main()
