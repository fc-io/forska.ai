import {$} from 'bun'
import {existsSync, mkdirSync} from 'fs'
import {join} from 'path'

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
  if (process.env.DB_VOLUME) return process.env.DB_VOLUME
  const vol = await pickVolume(['forska-stack_pgdata', 'pgdata'])
  return vol ?? fail('No Docker volume found for Postgres (set DB_VOLUME env)')
}

const stageFromVolume = async (volume: string): Promise<void> => {
  if (!existsSync('pgdata')) mkdirSync('pgdata', {recursive: true})
  log(`Staging data from Docker volume '${volume}' into ./pgdata`)
  const cmd = `docker run --rm -v ${volume}:/from -v "${process.cwd()}/pgdata":/to alpine sh -lc 'rm -rf /to/* && cp -a /from/. /to/'`
  const res = await nothrow`bash -lc ${cmd}`
  if (res.exitCode !== 0) fail('Failed to copy from Docker volume to ./pgdata')
}

const main = async (): Promise<void> => {
  if (!hasArg('--force')) fail('Refusing to rsync pgdata without --force (ensure Postgres stopped on both ends)')
  await assertLocalDbStopped()
  const vol = await getPgVolume()
  await stageFromVolume(vol)
  const sshAlias = requireEnv('SSH_ALIAS')
  const stackRoot = requireEnv('STACK_ROOT')
  log(`Pushing ./pgdata -> ${sshAlias}:${stackRoot}/pgdata/ via rsync`)
  await nothrow`ssh ${sshAlias} mkdir -p ${stackRoot}/pgdata`
  const sync = await nothrow`rsync -az --delete pgdata/ ${sshAlias}:${stackRoot}/pgdata/`
  if (sync.exitCode !== 0) fail('rsync failed')
  log('Done')
}

void main()
