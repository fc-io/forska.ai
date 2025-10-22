import Bun from 'bun'

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

const spawn = async (cmd: string, args: string[]): Promise<number> => {
  const child = Bun.spawn([cmd, ...args], {stdio: ['inherit', 'inherit', 'inherit']})
  return await child.exited
}

const main = async (): Promise<void> => {
  if (!hasArg('--force')) fail('Refusing to rsync pgdata without --force (ensure Postgres stopped on both ends)')
  const sshAlias = requireEnv('SSH_ALIAS')
  const stackRoot = requireEnv('STACK_ROOT')
  log(`Pushing ./pgdata -> ${sshAlias}:${stackRoot}/pgdata/ via rsync`)
  await spawn('ssh', [sshAlias, 'mkdir', '-p', `${stackRoot}/pgdata`])
  const code = await spawn('rsync', ['-az', '--delete', 'pgdata/', `${sshAlias}:${stackRoot}/pgdata/`])
  if (code !== 0) fail('rsync failed')
  log('Done')
}

void main()
