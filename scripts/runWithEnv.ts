import {realpathSync} from 'node:fs'

type ParsedRunWithEnvArgs = {command: string[]; env: Record<string, string | undefined>}

const bunExecutablePath = realpathSync(process.execPath)

const resolveCommandExecutable = (command: string) => {
  if (command === 'bun') {
    return bunExecutablePath
  }

  return globalThis.Bun.which(command) ?? command
}

export const parseRunWithEnvArgs = (argv: string[]): ParsedRunWithEnvArgs => {
  const separatorIndex = argv.indexOf('--')

  if (separatorIndex === -1) {
    throw new Error('Expected one or more KEY=value entries followed by -- and a command')
  }

  const envEntries = argv.slice(0, separatorIndex)
  const command = argv.slice(separatorIndex + 1)

  if (envEntries.length === 0 || command.length === 0) {
    throw new Error('Expected one or more KEY=value entries followed by -- and a command')
  }

  const env: Record<string, string | undefined> = {}

  for (const entry of envEntries) {
    const equalsIndex = entry.indexOf('=')

    if (equalsIndex <= 0) {
      throw new Error(`Expected env entry in KEY=value form, received ${entry}`)
    }

    env[entry.slice(0, equalsIndex)] = entry.slice(equalsIndex + 1)
  }

  return {command: [resolveCommandExecutable(command[0] ?? ''), ...command.slice(1)], env}
}

const runWithEnv = async () => {
  const {command, env} = parseRunWithEnvArgs(process.argv.slice(2))
  const childProcess = globalThis.Bun.spawn(command, {
    cwd: process.cwd(),
    env: {...process.env, ...env},
    stderr: 'inherit',
    stdin: 'inherit',
    stdout: 'inherit',
  })

  process.exit(await childProcess.exited)
}

if (import.meta.main) {
  await runWithEnv()
}
