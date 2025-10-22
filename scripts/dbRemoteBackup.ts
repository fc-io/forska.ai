import {$} from 'bun'
import {mkdirSync} from 'fs'

const log = (s: string): void => {
  console.log(`[dbRemoteBackup] ${s}`)
}

const fail = (s: string): never => {
  console.error(`[dbRemoteBackup] ${s}`)
  process.exit(1)
}

const nowStamp = (): string => {
  const d = new Date()
  const z = (n: number): string => (n < 10 ? `0${n}` : `${n}`)
  return `${d.getFullYear()}${z(d.getMonth() + 1)}${z(d.getDate())}_${z(d.getHours())}${z(d.getMinutes())}${z(d.getSeconds())}`
}

const requireEnv = (k: string): string => {
  const v = process.env[k]
  return v && v.length > 0 ? v : fail(`Missing env ${k}`)
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

const main = async (): Promise<void> => {
  const sshAlias = requireEnv('SSH_ALIAS')
  const stackRoot = requireEnv('STACK_ROOT')
  const remote = parseDbUrl(process.env.REMOTE_DATABASE_URL)
  mkdirSync('backups', {recursive: true})
  await $.nothrow()`ssh ${sshAlias} mkdir -p ${stackRoot}/backups`
  const remoteDump = `${stackRoot}/backups/dump_remote_${remote.db}_${nowStamp()}.dump`
  log('Creating remote dump via Apptainer (pg_dump)')
  const res = await $.nothrow()`ssh ${sshAlias} apptainer exec --env PGPASSWORD=${remote.pass} docker://postgres:18 pg_dump -h ${remote.host} -p ${remote.port} -U ${remote.user} -d ${remote.db} -Fc -Z 9 -f ${remoteDump}`
  if (res.exitCode !== 0) fail('remote pg_dump failed')
  log('Copying remote dump to local backups/')
  const pull = await $.nothrow()`scp ${sshAlias}:${remoteDump} backups/`
  if (pull.exitCode !== 0) fail('scp failed')
  log('Done')
}

void main()

