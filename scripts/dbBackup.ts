import Bun from 'bun'
import {mkdirSync} from 'fs'

const log = (s: string): void => {
  console.log(`[dbBackup] ${s}`)
}

const fail = (s: string): never => {
  console.error(`[dbBackup] ${s}`)
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

const spawn = async (cmd: string, args: string[], env?: Record<string, string>): Promise<number> => {
  const child = Bun.spawn([cmd, ...args], {
    stdio: ['inherit', 'inherit', 'inherit'],
    env: env ? {...process.env, ...env} : process.env,
  })
  return await child.exited
}

const getDbVars = (): {user: string; pass: string; db: string} => {
  const user = process.env.DB_USER || 'postgres'
  const pass = process.env.DB_PASS || ''
  const db = process.env.DB_NAME || 'postgres'
  return {user, pass, db}
}

const main = async (): Promise<void> => {
  const {user, pass, db} = getDbVars()
  ensureDir('backups')
  const out = `backups/dump_local_${db}_${nowStamp()}.dump`
  log(`Creating dump via docker compose exec -> ${out}`)
  const redir = `> ${out}`
  const cmd = [
    `docker compose exec -e PGPASSWORD='${pass.replace(/'/g, "'\\''")}' -T db pg_dump -U ${user} -d ${db} -Fc -Z 9 ${redir}`,
  ]
  const code = await spawn('bash', ['-lc', cmd.join(' ')])
  if (code !== 0) fail('pg_dump failed')
  log('Done')
}

void main()
