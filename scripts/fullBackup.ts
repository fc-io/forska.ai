
import {$} from 'bun'
import {mkdirSync} from 'fs'

import {env} from './env.ts'

const log = (s: string): void => {
  console.log(`[fullBackup] ${s}`)
}

const fail = (s: string): never => {
  console.error(`[fullBackup] ${s}`)
  process.exit(1)
}

const nowStamp = (): string => {
  const d = new Date()
  const pad = (n: number): string => {
    return n < 10 ? `0${n}` : `${n}`
  }
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
}

const ensureDir = (p: string): void => {
  mkdirSync(p, {recursive: true})
}

const getDbVars = (): {user: string; pass: string; db: string} => {
  const user = env.DB_USER || 'postgres'
  const pass = env.DB_PASS || ''
  const db = env.DB_NAME || 'postgres'
  return {user, pass, db}
}

const backupPostgres = async (timestamp: string): Promise<void> => {
  const {user, pass, db} = getDbVars()
  const out = `backups/dump_local_${db}_${timestamp}.dump`
  log(`Backing up Postgres to ${out}...`)

  const redir = `> ${out}`
  // Using -Fc (Custom) format is best for restores
  const cmd = `docker compose exec -e PGPASSWORD='${pass.replace(/'/g, "'\\''")}' -T db pg_dump -U ${user} -d ${db} -Fc -Z 9 ${redir}`

  const res = await $.nothrow()`bash -lc ${cmd}`
  if (res.exitCode !== 0) fail('pg_dump failed')
  log('Postgres backup complete.')
}

const backupSeaweedS3 = async (): Promise<void> => {
  const bucket = 'forska-judgments'
  const endpoint = 'http://localhost:8333'
  const accessKey = 'admin'
  const secretKey = 'admin'
  const destDir = `backups/s3-mirror/${bucket}`

  log(`Syncing S3 bucket ${bucket} to ${destDir}...`)

  // Note: We use 'sync' which only downloads new/modified files.
  // This is efficient for Dropbox sync as well.
  const cmd = `AWS_ACCESS_KEY_ID=${accessKey} AWS_SECRET_ACCESS_KEY=${secretKey} aws s3 sync s3://${bucket} ./${destDir} --endpoint-url ${endpoint}`

  const res = await $.nothrow()`bash -lc ${cmd}`
  if (res.exitCode !== 0) fail('aws s3 sync failed')
  log('S3 sync complete.')
}

const main = async (): Promise<void> => {
  ensureDir('backups')
  ensureDir('backups/s3-mirror')

  const ts = nowStamp()

  log('Starting full backup...')

  // Run in parallel? Maybe sequential is safer for logs
  await backupPostgres(ts)
  await backupSeaweedS3()

  log('Full backup process finished successfully.')
  log('Ensure your "backups" folder is synced to Dropbox/Cloud storage.')
}

void main()
