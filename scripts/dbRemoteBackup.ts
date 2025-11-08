import {$} from 'bun'
import {mkdirSync} from 'fs'
import {env} from './env.ts'

const log = (s: string): void => {
  console.log(`[dbRemoteBackup] ${s}`)
}

const fail = (s: string): never => {
  console.error(`[dbRemoteBackup] ${s}`)
  process.exit(1)
}

const nowStamp = (): string => {
  const d = new Date()
  const p = (n: number): string => (n < 10 ? `0${n}` : `${n}`)
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
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

const hasLocalPgDump = async (): Promise<boolean> => {
  return (await $.nothrow()`pg_dump --version`).exitCode === 0
}

const isLocalHost = (h: string): boolean => h === 'localhost' || h === '127.0.0.1'

const main = async (): Promise<void> => {
  const remoteUrl = env.REMOTE_DATABASE_URL
  if (!remoteUrl) fail('REMOTE_DATABASE_URL is not set')

  const {host, port, user, pass, db} = parseDbUrl(remoteUrl)
  mkdirSync('backups', {recursive: true})
  const out = `backups/dump_remote_${db}_${nowStamp()}.dump`

  // Prefer local pg_dump if available (works with SSH tunnels on localhost)
  if (await hasLocalPgDump()) {
    log(`Creating dump via local pg_dump -> ${out}`)
    log('Starting dump (this may take a while for large databases)...')
    const cmd = `PGPASSWORD='${pass.replace(/'/g, "'\\''")}' pg_dump -h ${host} -p ${port} -U ${user} -d ${db} -Fc -Z 9 --verbose -f ${out}`
    const proc = Bun.spawn(['bash', '-lc', cmd], {
      stdout: 'inherit',
      stderr: 'inherit',
    })
    const exitCode = await proc.exited
    if (exitCode !== 0) fail('pg_dump failed')
    log('Done')
    return
  }

  // Fallback: run pg_dump from a Postgres image via Docker and stream to host
  // Note: when targeting localhost from inside Docker, use host.docker.internal
  const dockerHost = isLocalHost(host) ? 'host.docker.internal' : host
  log(`Local pg_dump not found; using Docker to dump -> ${out}`)
  log('Starting dump (this may take a while for large databases)...')
  const dockerCmd = `docker run --rm -e PGPASSWORD='${pass.replace(/'/g, "'\\''")}' postgres:18 pg_dump -h ${dockerHost} -p ${port} -U ${user} -d ${db} -Fc -Z 9 --verbose -f - > ${out}`
  const proc = Bun.spawn(['bash', '-lc', dockerCmd], {
      stdout: 'inherit',
      stderr: 'inherit',
    })
  const exitCode = await proc.exited
  if (exitCode !== 0) fail('docker pg_dump failed')
  log('Done')
}

void main()
