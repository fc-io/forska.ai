import {$} from 'bun'
import {existsSync, mkdirSync} from 'fs'
import {join} from 'path'
import {env} from './env.ts'

const log = (s: string): void => {
  console.log(`[dbPull] ${s}`)
}

const fail = (s: string): never => {
  console.error(`[dbPull] ${s}`)
  process.exit(1)
}

const hasArg = (k: string): boolean => {
  return process.argv.includes(k)
}

const nothrow = $.nothrow()

const assertLocalDbStopped = async (): Promise<void> => {
  const id = (await nothrow`docker compose ps -q db`.text()).trim()
  if (id) {
    const running = (await nothrow`docker inspect -f {{.State.Running}} ${id}`.text()).trim()
    if (running === 'true') fail('Local docker compose db is running. Stop it: docker compose stop db')
  }
  const pidPath = join('pgdata', 'postmaster.pid')
  if (existsSync(pidPath))
    fail('Detected postmaster.pid in ./pgdata. Local Postgres appears running. Stop it before rsync.')
}

const volumeExists = async (name: string): Promise<boolean> => {
  return (await nothrow`docker volume inspect ${name}`).exitCode === 0
}

const pickVolume = async (names: string[]): Promise<string | undefined> => {
  return names.length === 0 ? undefined : (await volumeExists(names[0])) ? names[0] : await pickVolume(names.slice(1))
}

const getPgVolume = async (): Promise<string> => {
  if (env.DB_VOLUME) return env.DB_VOLUME
  const vol = await pickVolume(['forska-stack_pgdata', 'pgdata'])
  return vol ?? fail('No Docker volume found for Postgres (set DB_VOLUME env)')
}

const copyIntoVolume = async (volume: string): Promise<void> => {
  if (!existsSync('pgdata')) mkdirSync('pgdata', {recursive: true})
  log(`Copying ./pgdata into Docker volume '${volume}'`)
  const cmd = `docker run --rm -v ${volume}:/to -v "${process.cwd()}/pgdata":/from alpine sh -lc 'rm -rf /to/* && cp -a /from/. /to/'`
  const res = await nothrow`bash -lc ${cmd}`
  if (res.exitCode !== 0) fail('Failed to copy from ./pgdata into Docker volume')
}

const main = async (): Promise<void> => {
  if (!hasArg('--force')) fail('Refusing to rsync pgdata without --force (ensure Postgres stopped on both ends)')
  await assertLocalDbStopped()
  const sshAlias = env.SSH_ALIAS
  const stackRoot = env.STACK_ROOT
  log(`Pulling ${sshAlias}:${stackRoot}/pgdata/ -> ./pgdata via rsync`)
  if (!existsSync('pgdata')) mkdirSync('pgdata', {recursive: true})
  const sync = await nothrow`rsync -az --delete ${sshAlias}:${stackRoot}/pgdata/ pgdata/`
  if (sync.exitCode !== 0) fail('rsync failed')
  const vol = await getPgVolume()
  await copyIntoVolume(vol)
  log('Done')
}

void main()
