import {fileURLToPath} from 'node:url'

import {assertAppleContainerDatabaseIsIdle, getAppleContainerHostDatabase} from './appleContainerHostDatabase.ts'

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url))
const containerName = 'forska-dev-8gb'

export const getAppleContainerCommands = ({
  port = '3300',
  memory = '8G',
  commitSha = 'unknown',
  hostDatabase,
}: {
  port?: string
  memory?: string
  commitSha?: string
  hostDatabase?: ReturnType<typeof getAppleContainerHostDatabase>
} = {}) => {
  if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) {
    throw new Error('FORSKA_CONTAINER_PORT must be a port between 1 and 65535')
  }

  if (!/^[1-9]\d*G$/.test(memory) || !Number.isSafeInteger(Number(memory.slice(0, -1)))) {
    throw new Error('FORSKA_CONTAINER_MEMORY must be a positive whole GiB value, such as 8G or 16G')
  }

  return [
    ['container', 'system', 'start', '--disable-kernel-install'],
    ['container', 'build', '--file', 'containers/apple/Dockerfile', '--tag', 'forska-dev:local', '.'],
    [
      'container',
      'run',
      '--name',
      containerName,
      '--rm',
      '--init',
      '--interactive',
      '--memory',
      memory,
      '--publish',
      `127.0.0.1:${port}:3000`,
      '--volume',
      'forska-dev-data:/data',
      ...(hostDatabase
        ? [
            '--volume',
            `${hostDatabase.directory}:/data/share/forska/runtime/primary`,
            '--volume',
            `${hostDatabase.assetsDirectory}:/data/assets`,
          ]
        : []),
      '--env',
      `FORSKA_COMMIT_SHA=${commitSha}`,
      'forska-dev:local',
      'bun',
      'run',
      'dev:start',
    ],
  ]
}

const runCommand = async (command: string[]) => {
  const child = globalThis.Bun.spawn(command, {
    cwd: repositoryRoot,
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
  })
  const stop = () => {
    if (command[1] === 'run') {
      globalThis.Bun.spawn(['container', 'stop', '--signal', 'SIGTERM', '--time', '60', containerName], {
        stdout: 'inherit',
        stderr: 'inherit',
      })
    } else {
      child.kill('SIGTERM')
    }
  }
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
  const exitCode = await child.exited
  process.removeListener('SIGINT', stop)
  process.removeListener('SIGTERM', stop)
  if (exitCode !== 0) {
    throw new Error(`${command.slice(0, 2).join(' ')} exited with code ${exitCode}`)
  }
}

const runAppleContainer = async () => {
  const dryRun = process.argv.includes('--dry-run')
  if (!dryRun && (process.platform !== 'darwin' || process.arch !== 'arm64')) {
    throw new Error('Apple containers require an Apple Silicon Mac. See containers/apple/README.md.')
  }
  if (!dryRun && !globalThis.Bun.which('container')) {
    throw new Error('Install the Apple container CLI first: https://github.com/apple/container/releases')
  }
  const git = globalThis.Bun.which('git')
    ? globalThis.Bun.spawnSync(['git', 'rev-parse', 'HEAD'], {cwd: repositoryRoot})
    : null
  const commitSha = git?.exitCode === 0 ? git.stdout.toString().trim() : 'unknown'
  const hostDatabase = process.argv.includes('--host-db') ? getAppleContainerHostDatabase(repositoryRoot) : undefined
  const memory = process.env.FORSKA_CONTAINER_MEMORY ?? '8G'
  const commands = getAppleContainerCommands({port: process.env.FORSKA_CONTAINER_PORT, memory, commitSha, hostDatabase})
  if (hostDatabase) {
    console.log(
      `[dev:container] WRITABLE host DB: ${hostDatabase.databasePath}; keep the host app stopped until the container exits`,
    )
  }
  console.log(
    `[dev:container] http://localhost:${process.env.FORSKA_CONTAINER_PORT ?? '3300'}; memory=${memory}; volume=forska-dev-data`,
  )
  for (const command of commands) {
    console.log(command.join(' '))
    if (!dryRun) {
      if (hostDatabase && command[1] === 'run') {
        assertAppleContainerDatabaseIsIdle(hostDatabase.databasePath)
      }
      await runCommand(command)
    }
  }
}

if (import.meta.main) {
  runAppleContainer().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
