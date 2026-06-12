export const devStartCommands = [
  {
    command: ['bun', 'scripts/runWithRuntimeProfile.ts', '--profile', 'primary', '--mode', 'app'],
    name: 'app',
    stdin: 'ignore',
  },
  {
    command: ['bun', 'scripts/runWithRuntimeProfile.ts', '--profile', 'primary', '--mode', 'stacked-server'],
    name: 'api',
    stdin: 'inherit',
  },
] as const

type DevStartCommand = (typeof devStartCommands)[number]
type DevStartProcess = {
  childProcess: ReturnType<typeof globalThis.Bun.spawn>
  name: DevStartCommand['name']
}

const activeProcesses: DevStartProcess[] = []
let shuttingDown = false

const startDevProcess = (commandConfig: DevStartCommand) => {
  const childProcess = globalThis.Bun.spawn([...commandConfig.command], {
    cwd: process.cwd(),
    env: {...process.env},
    stderr: 'inherit',
    stdin: commandConfig.stdin,
    stdout: 'inherit',
  })

  console.log(`[dev:start] started ${commandConfig.name} pid=${childProcess.pid ?? 'unknown'}`)

  return {childProcess, name: commandConfig.name}
}

const stopDevProcess = async ({childProcess}: DevStartProcess) => {
  if (childProcess.exitCode !== null) {
    await childProcess.exited.catch(() => {
      return null
    })
    return
  }

  childProcess.kill('SIGTERM')
  await childProcess.exited.catch(() => {
    return null
  })
}

const stopDevProcesses = async () => {
  await Promise.all(activeProcesses.map(stopDevProcess))
}

const shutdown = async (exitCode = 0) => {
  if (shuttingDown) {
    return
  }

  shuttingDown = true
  await stopDevProcesses()
  process.exit(exitCode)
}

const getExitCode = async ({childProcess}: DevStartProcess) => {
  return childProcess.exited.catch(() => {
    return 1
  })
}

const monitorDevProcess = async (devProcess: DevStartProcess) => {
  const exitCode = await getExitCode(devProcess)

  if (shuttingDown) {
    return
  }

  console.error(`[dev:start] ${devProcess.name} exited with code ${exitCode}`)
  await shutdown(exitCode)
}

export const runDevStart = async () => {
  process.once('SIGINT', () => {
    void shutdown(0)
  })

  process.once('SIGTERM', () => {
    void shutdown(0)
  })

  activeProcesses.push(...devStartCommands.map(startDevProcess))
  await Promise.all(activeProcesses.map(monitorDevProcess))
}

if (import.meta.main) {
  await runDevStart()
}
