import {existsSync, mkdirSync, readFileSync, realpathSync, rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

import {expect, test} from 'bun:test'

import {getRuntimeProfileDuckdbPath} from '../src/utils/runtimeProfile.ts'
import {getRuntimeProfileCommandEnv} from './runWithRuntimeProfile.ts'

type SpawnedProcess = ReturnType<typeof globalThis.Bun.spawn>
type RuntimeReadyBody = {data?: {ready?: boolean; role?: string}}
type RuntimeStateBody = {data?: {pid?: number; role?: string}}
type StackStartedPids = {api: number | null; judge: number | null; maintenance: number | null}
type PipeTextCollector = {done: Promise<void>; getText: () => string}

const bunExecutablePath = realpathSync(process.execPath)
const realDevServerSmokeEnabled = process.env.FORSKA_REAL_DEV_SERVER_SMOKE === 'true'
const forbiddenDevServerOutputPatterns = [
  {label: 'DuckDB owner heartbeat failure', pattern: /\[duckdb-owner\] heartbeat failed/},
  {label: 'maintenance restart', pattern: /\[server:stack\] restarting maintenance/},
  {label: 'maintenance unexpected exit', pattern: /\[server:stack\] maintenance pid=\d+ exited with code 0/},
  {label: 'judge duplicate replacement', pattern: /judge replacement is already ready after SIGTERM/},
  {label: 'judge unexpected SIGTERM exit', pattern: /\[server:stack\] judge pid=\d+ exited with code 143/},
] as const

const removePathIfExists = (path: string) => {
  if (existsSync(path)) {
    rmSync(path, {force: true, recursive: true})
  }
}

const getServerStackLockPath = (apiPort: number, maintenancePort: number, judgePort: number) => {
  return join(tmpdir(), 'forska-server-stack', `${apiPort}-${maintenancePort}-${judgePort}.lock.json`)
}

const waitForPathUntil = async (path: string, deadlineMs: number): Promise<void> => {
  if (existsSync(path)) {
    return
  }

  if (Date.now() >= deadlineMs) {
    throw new Error(`Timed out waiting for ${path}`)
  }

  await waitFor(100)
  return waitForPathUntil(path, deadlineMs)
}

const waitForPath = async (path: string, timeoutMs: number) => {
  return waitForPathUntil(path, Date.now() + timeoutMs)
}

const getForbiddenDevServerOutputMatches = (output: string) => {
  return forbiddenDevServerOutputPatterns.flatMap(({label, pattern}) => {
    return pattern.test(output) ? [label] : []
  })
}

const expectNoForbiddenDevServerOutput = (output: string) => {
  expect(getForbiddenDevServerOutputMatches(output), output).toEqual([])
}

const createPipeTextCollector = (pipe: SpawnedProcess['stdout']): PipeTextCollector => {
  let text = ''

  if (!(pipe instanceof ReadableStream)) {
    return {
      done: Promise.resolve(),
      getText: () => {
        return text
      },
    }
  }

  const decoder = new TextDecoder()
  const done = pipe
    .pipeTo(
      new WritableStream<Uint8Array>({
        abort: () => {
          text += decoder.decode()
        },
        close: () => {
          text += decoder.decode()
        },
        write: (chunk) => {
          text += decoder.decode(chunk, {stream: true})
        },
      }),
    )
    .catch(() => {
      text += decoder.decode()
    })

  return {
    done,
    getText: () => {
      return text
    },
  }
}

const getCollectedProcessOutput = (collectors: PipeTextCollector[]) => {
  return collectors
    .map((collector) => {
      return collector.getText()
    })
    .join('\n')
}

const waitForRuntimeReadyUntil = async (port: number, deadlineMs: number): Promise<RuntimeReadyBody> => {
  return fetch(`http://127.0.0.1:${port}/api/runtime/ready`)
    .then(async (response) => {
      if (!response.ok) {
        throw new Error(`Runtime on port ${port} returned ${response.status}`)
      }

      return (await response.json()) as RuntimeReadyBody
    })
    .catch((error) => {
      if (Date.now() >= deadlineMs) {
        throw error
      }

      return new Promise<RuntimeReadyBody>((resolve, reject) => {
        setTimeout(() => {
          waitForRuntimeReadyUntil(port, deadlineMs).then(resolve).catch(reject)
        }, 100)
      })
    })
}

const waitForRuntimeReady = async (port: number, timeoutMs: number): Promise<RuntimeReadyBody> => {
  return waitForRuntimeReadyUntil(port, Date.now() + timeoutMs)
}

const waitFor = async (ms: number) => {
  await new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

const getRuntimeState = async (port: number): Promise<RuntimeStateBody> => {
  const response = await fetch(`http://127.0.0.1:${port}/api/runtime/state`)

  if (!response.ok) {
    throw new Error(`Runtime state on port ${port} returned ${response.status}`)
  }

  return (await response.json()) as RuntimeStateBody
}

const getRuntimePids = async (ports: number[]) => {
  return Promise.all(
    ports.map(async (port) => {
      return (await getRuntimeState(port)).data?.pid ?? null
    }),
  )
}

const getRequiredRuntimePids = async (ports: [number, number, number]) => {
  const pids = await getRuntimePids(ports)

  if (
    !pids.every((pid) => {
      return typeof pid === 'number'
    })
  ) {
    throw new Error(`Expected runtime pids for ports ${ports.join(', ')}, received ${pids.join(', ')}`)
  }

  return pids as [number, number, number]
}

const readPipeText = async (pipe: SpawnedProcess['stdout']) => {
  return pipe instanceof ReadableStream ? await new Response(pipe).text() : ''
}

const readProcessOutput = async (processToRead: SpawnedProcess) => {
  const [stdout, stderr] = await Promise.all([readPipeText(processToRead.stdout), readPipeText(processToRead.stderr)])

  return `${stdout}\n${stderr}`
}

const getStackStartedPid = (output: string, role: keyof StackStartedPids) => {
  const matches = [...output.matchAll(new RegExp(`\\[server:stack\\] started ${role} pid=(\\d+)`, 'g'))]
  const latestMatch = matches.at(-1)

  return latestMatch ? Number(latestMatch[1]) : null
}

const getStackStartedPids = (output: string): StackStartedPids => {
  return {
    api: getStackStartedPid(output, 'api'),
    judge: getStackStartedPid(output, 'judge'),
    maintenance: getStackStartedPid(output, 'maintenance'),
  }
}

const waitForProcessExit = async (processToWaitFor: SpawnedProcess, timeoutMs: number) => {
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`Timed out waiting for pid=${processToWaitFor.pid ?? 'unknown'} to exit`))
    }, timeoutMs)

    processToWaitFor.exited
      .then(() => {
        clearTimeout(timeout)
        resolve()
      })
      .catch((error) => {
        clearTimeout(timeout)
        reject(error)
      })
  })
}

const getAvailableLocalPorts = async (count: number) => {
  const servers = Array.from({length: count}, () => {
    return globalThis.Bun.serve({
      fetch: () => {
        return new Response('ok')
      },
      hostname: '127.0.0.1',
      port: 0,
    })
  })
  const ports = servers.map((server) => {
    return server.port
  })
  await Promise.all(
    servers.map((server) => {
      return server.stop(true)
    }),
  )

  return ports
}

const getFourAvailableLocalPorts = async () => {
  const ports = await getAvailableLocalPorts(4)

  if (ports.length !== 4) {
    throw new Error(`Expected 4 available ports, received ${ports.length}`)
  }

  return ports as [number, number, number, number]
}

const getFiveAvailableLocalPorts = async () => {
  const ports = await getAvailableLocalPorts(5)

  if (ports.length !== 5) {
    throw new Error(`Expected 5 available ports, received ${ports.length}`)
  }

  return ports as [number, number, number, number, number]
}

const getCanStartLocalListener = async () => {
  try {
    await getAvailableLocalPorts(1)
    return true
  } catch {
    return false
  }
}

const canStartLocalListener = await getCanStartLocalListener()

const stopProcess = async (processToStop: SpawnedProcess) => {
  if (processToStop.exitCode === null) {
    processToStop.kill('SIGTERM')
  }

  await processToStop.exited
}

test('propagates the selected runtime profile into launcher child env', () => {
  expect(getRuntimeProfileCommandEnv({mode: 'app', profileName: 'primary'}).FORSKA_RUNTIME_PROFILE).toBe('primary')

  expect(
    getRuntimeProfileCommandEnv({mode: 'maintenance-only-server', profileName: 'secondary'}).FORSKA_RUNTIME_PROFILE,
  ).toBe('secondary')
})

test('fixes sink-owning runtime service names in launcher child env', () => {
  expect(getRuntimeProfileCommandEnv({mode: 'app-server', profileName: 'primary'}).FORSKA_RUNTIME_SERVICE).toBe(
    'app-server',
  )
  expect(getRuntimeProfileCommandEnv({mode: 'api-only-server', profileName: 'primary'}).FORSKA_RUNTIME_SERVICE).toBe(
    'api-server',
  )
  expect(
    getRuntimeProfileCommandEnv({mode: 'maintenance-only-server', profileName: 'primary'}).FORSKA_RUNTIME_SERVICE,
  ).toBe('maintenance-worker-server')
  expect(getRuntimeProfileCommandEnv({mode: 'judge-only-server', profileName: 'primary'}).FORSKA_RUNTIME_SERVICE).toBe(
    'judge-worker-server',
  )
  expect(getRuntimeProfileCommandEnv({mode: 'stacked-server', profileName: 'primary'}).FORSKA_RUNTIME_SERVICE).toBe(
    'dev-single-server',
  )
})

test('maintenance-only launcher uses the maintenance-worker runtime role', () => {
  expect(getRuntimeProfileCommandEnv({mode: 'maintenance-only-server', profileName: 'primary'}).SERVER_ROLE).toBe(
    'maintenance-worker',
  )
})

test('judge-only launcher uses the judge-worker runtime role and journal identity', () => {
  expect(getRuntimeProfileCommandEnv({mode: 'judge-only-server', profileName: 'secondary'})).toMatchObject({
    API_SERVER_PORT: '3103',
    FORSKA_RUNTIME_PROFILE: 'secondary',
    JUDGE_WORKER_ID: 'secondary-judge-worker',
    SERVER_DUCKDB_OWNER_URL: 'http://127.0.0.1:3102',
    SERVER_ROLE: 'judge-worker',
  })
})

test('judge-only launcher clears inherited explicit journal paths', () => {
  const previousJournalPath = process.env.JUDGE_WORKER_JOURNAL_PATH
  process.env.JUDGE_WORKER_JOURNAL_PATH = 'data/custom/judge.sqlite'

  try {
    expect(getRuntimeProfileCommandEnv({mode: 'judge-only-server', profileName: 'primary'})).toMatchObject({
      JUDGE_WORKER_ID: 'primary-judge-worker',
      JUDGE_WORKER_JOURNAL_PATH: '',
      SERVER_ROLE: 'judge-worker',
    })
  } finally {
    if (previousJournalPath === undefined) {
      delete process.env.JUDGE_WORKER_JOURNAL_PATH
    }

    if (previousJournalPath !== undefined) {
      process.env.JUDGE_WORKER_JOURNAL_PATH = previousJournalPath
    }
  }
})

test('stacked server launcher carries split-role port and journal identity wiring', () => {
  expect(getRuntimeProfileCommandEnv({mode: 'stacked-server', profileName: 'primary'})).toMatchObject({
    API_SERVER_PORT: '3001',
    BACKGROUND_JUDGE_PORT: '3003',
    BACKGROUND_MAINTENANCE_PORT: '3002',
    DUCKDB_PATH: getRuntimeProfileDuckdbPath({profileName: 'primary'}),
    FORSKA_RUNTIME_PROFILE: 'primary',
    FORSKA_RUNTIME_SERVICE: 'dev-single-server',
    JUDGE_WORKER_ID: 'primary-judge-worker',
  })
})

test(
  'server stack script starts api, maintenance-worker, and judge-worker together',
  async () => {
    if (!canStartLocalListener) {
      expect(canStartLocalListener).toBe(false)
      return
    }

    const dataRoot = join(process.cwd(), 'data', 'runtime', `run-with-runtime-profile-stack-${Date.now()}`)
    const duckdbPath = join(dataRoot, 'forska.duckdb')
    const [vitePort, apiPort, maintenancePort, judgePort] = await getFourAvailableLocalPorts()

    mkdirSync(dataRoot, {recursive: true})

    const stackProcess = globalThis.Bun.spawn([bunExecutablePath, 'scripts/startServerStack.ts'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        API_SERVER_PORT: String(apiPort),
        BACKGROUND_JUDGE_PORT: String(judgePort),
        BACKGROUND_MAINTENANCE_PORT: String(maintenancePort),
        DUCKDB_PATH: duckdbPath,
        JUDGE_WORKER_ID: 'run-with-runtime-profile-stack-judge',
        RUN_SERVER_FULL_TEXT_CONVERSION_CRON: 'false',
        RUN_SERVER_FULL_TEXT_FETCHING: 'false',
        VITE_PORT: String(vitePort),
      },
      stderr: 'pipe',
      stdout: 'pipe',
    })

    try {
      const pidsAfterReady = await (async (): Promise<[number, number, number]> => {
        const [apiReady, maintenanceReady, judgeReady] = await Promise.all([
          waitForRuntimeReady(apiPort, 20_000),
          waitForRuntimeReady(maintenancePort, 20_000),
          waitForRuntimeReady(judgePort, 20_000),
        ])

        expect(apiReady.data).toMatchObject({ready: true, role: 'api'})
        expect(maintenanceReady.data).toMatchObject({ready: true, role: 'maintenance-worker'})
        expect(judgeReady.data).toMatchObject({ready: true, role: 'judge-worker'})

        const runtimePids = await getRequiredRuntimePids([apiPort, maintenancePort, judgePort])
        await waitFor(2_500)
        expect(await getRuntimePids([apiPort, maintenancePort, judgePort])).toEqual(runtimePids)
        return runtimePids
      })()
      const stackLockPath = getServerStackLockPath(apiPort, maintenancePort, judgePort)

      expect(existsSync(stackLockPath)).toBe(true)
      removePathIfExists(stackLockPath)
      await waitForPath(stackLockPath, 5_000)
      expect((JSON.parse(readFileSync(stackLockPath, 'utf8')) as {pid?: number}).pid).toBe(stackProcess.pid)

      await stopProcess(stackProcess)

      const stackOutput = await readProcessOutput(stackProcess)

      expect(getStackStartedPids(stackOutput)).toEqual({
        api: pidsAfterReady[0],
        judge: pidsAfterReady[2],
        maintenance: pidsAfterReady[1],
      })
      expectNoForbiddenDevServerOutput(stackOutput)
    } finally {
      await stopProcess(stackProcess)
      removePathIfExists(dataRoot)
    }
  },
  {timeout: 30_000},
)

test(
  'real primary dev:server startup has no DuckDB owner heartbeat or restart errors',
  async () => {
    if (!realDevServerSmokeEnabled) {
      expect(realDevServerSmokeEnabled).toBe(false)
      return
    }

    const devServerProcess = globalThis.Bun.spawn([bunExecutablePath, 'run', 'dev:server'], {
      cwd: process.cwd(),
      env: {...process.env, FORSKA_DEV_SERVER_WATCH_ACTION: 'restart'},
      stderr: 'pipe',
      stdout: 'pipe',
    })
    const stdout = createPipeTextCollector(devServerProcess.stdout)
    const stderr = createPipeTextCollector(devServerProcess.stderr)
    const collectors = [stdout, stderr]

    try {
      await Promise.race([
        Promise.all([
          waitForRuntimeReady(3001, 45_000),
          waitForRuntimeReady(3002, 45_000),
          waitForRuntimeReady(3003, 45_000),
        ]),
        devServerProcess.exited.then((exitCode) => {
          throw new Error(`dev:server exited before all roles became ready with code ${String(exitCode)}`)
        }),
      ])

      await Promise.race([
        waitFor(17_000),
        devServerProcess.exited.then((exitCode) => {
          throw new Error(`dev:server exited during startup settle with code ${String(exitCode)}`)
        }),
      ])
    } finally {
      await stopProcess(devServerProcess)
    }

    await Promise.all(
      collectors.map((collector) => {
        return collector.done
      }),
    )
    expectNoForbiddenDevServerOutput(getCollectedProcessOutput(collectors))
  },
  {timeout: 90_000},
)

test(
  'server stack startup takes over a live conflicting judge worker before spawning its own judge role',
  async () => {
    if (!canStartLocalListener) {
      expect(canStartLocalListener).toBe(false)
      return
    }

    const dataRoot = join(process.cwd(), 'data', 'runtime', `run-with-runtime-profile-judge-takeover-${Date.now()}`)
    const duckdbPath = join(dataRoot, 'forska.duckdb')
    const [vitePort, standaloneJudgePort, apiPort, maintenancePort, judgePort] = await getFiveAvailableLocalPorts()

    mkdirSync(dataRoot, {recursive: true})

    const conflictingJudgeProcess = globalThis.Bun.spawn([bunExecutablePath, 'src/server/index.ts'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        API_SERVER_PORT: String(standaloneJudgePort),
        DUCKDB_PATH: duckdbPath,
        JUDGE_WORKER_ID: 'run-with-runtime-profile-stack-judge',
        JUDGE_WORKER_JOURNAL_PATH: '',
        RUN_SERVER_FULL_TEXT_CONVERSION_CRON: 'false',
        RUN_SERVER_FULL_TEXT_FETCHING: 'false',
        SERVER_DUCKDB_OWNER_URL: '',
        SERVER_ROLE: 'judge-worker',
        VITE_PORT: String(vitePort),
      },
      stderr: 'pipe',
      stdout: 'pipe',
    })

    let stackProcess: SpawnedProcess | null = null

    try {
      await waitForRuntimeReady(standaloneJudgePort, 20_000)

      stackProcess = globalThis.Bun.spawn([bunExecutablePath, 'scripts/startServerStack.ts'], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          API_SERVER_PORT: String(apiPort),
          BACKGROUND_JUDGE_PORT: String(judgePort),
          BACKGROUND_MAINTENANCE_PORT: String(maintenancePort),
          DUCKDB_PATH: duckdbPath,
          JUDGE_WORKER_ID: 'run-with-runtime-profile-stack-judge',
          JUDGE_WORKER_JOURNAL_PATH: '',
          RUN_SERVER_FULL_TEXT_CONVERSION_CRON: 'false',
          RUN_SERVER_FULL_TEXT_FETCHING: 'false',
          VITE_PORT: String(vitePort),
        },
        stderr: 'pipe',
        stdout: 'pipe',
      })

      const [apiReady, maintenanceReady, judgeReady] = await Promise.all([
        waitForRuntimeReady(apiPort, 20_000),
        waitForRuntimeReady(maintenancePort, 20_000),
        waitForRuntimeReady(judgePort, 20_000),
        waitForProcessExit(conflictingJudgeProcess, 20_000),
      ])

      expect(apiReady.data).toMatchObject({ready: true, role: 'api'})
      expect(maintenanceReady.data).toMatchObject({ready: true, role: 'maintenance-worker'})
      expect(judgeReady.data).toMatchObject({ready: true, role: 'judge-worker'})
    } finally {
      if (stackProcess !== null) {
        await stopProcess(stackProcess)
      }

      await stopProcess(conflictingJudgeProcess)
      removePathIfExists(dataRoot)
    }
  },
  {timeout: 30_000},
)

test(
  'server stack startup takes over a live conflicting DuckDB owner before spawning its maintenance role',
  async () => {
    if (!canStartLocalListener) {
      expect(canStartLocalListener).toBe(false)
      return
    }

    const dataRoot = join(process.cwd(), 'data', 'runtime', `run-with-runtime-profile-owner-takeover-${Date.now()}`)
    const duckdbPath = join(dataRoot, 'forska.duckdb')
    const [vitePort, apiPort, maintenancePort, judgePort] = await getFourAvailableLocalPorts()

    mkdirSync(dataRoot, {recursive: true})

    const conflictingMaintenanceProcess = globalThis.Bun.spawn([bunExecutablePath, 'src/server/index.ts'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        API_SERVER_PORT: String(maintenancePort),
        DUCKDB_PATH: duckdbPath,
        RUN_SERVER_FULL_TEXT_CONVERSION_CRON: 'false',
        RUN_SERVER_FULL_TEXT_FETCHING: 'false',
        SERVER_DUCKDB_OWNER_URL: '',
        SERVER_ROLE: 'maintenance-worker',
        VITE_PORT: String(vitePort),
      },
      stderr: 'pipe',
      stdout: 'pipe',
    })

    let stackProcess: SpawnedProcess | null = null

    try {
      await waitForRuntimeReady(maintenancePort, 20_000)

      stackProcess = globalThis.Bun.spawn([bunExecutablePath, 'scripts/startServerStack.ts'], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          API_SERVER_PORT: String(apiPort),
          BACKGROUND_JUDGE_PORT: String(judgePort),
          BACKGROUND_MAINTENANCE_PORT: String(maintenancePort),
          DUCKDB_PATH: duckdbPath,
          JUDGE_WORKER_ID: 'run-with-runtime-profile-owner-takeover-judge',
          JUDGE_WORKER_JOURNAL_PATH: '',
          RUN_SERVER_FULL_TEXT_CONVERSION_CRON: 'false',
          RUN_SERVER_FULL_TEXT_FETCHING: 'false',
          VITE_PORT: String(vitePort),
        },
        stderr: 'pipe',
        stdout: 'pipe',
      })

      const [apiReady, maintenanceReady, judgeReady] = await Promise.all([
        waitForRuntimeReady(apiPort, 20_000),
        waitForRuntimeReady(maintenancePort, 20_000),
        waitForRuntimeReady(judgePort, 20_000),
        waitForProcessExit(conflictingMaintenanceProcess, 20_000),
      ])

      expect(apiReady.data).toMatchObject({ready: true, role: 'api'})
      expect(maintenanceReady.data).toMatchObject({ready: true, role: 'maintenance-worker'})
      expect(judgeReady.data).toMatchObject({ready: true, role: 'judge-worker'})
    } finally {
      if (stackProcess !== null) {
        await stopProcess(stackProcess)
      }

      await stopProcess(conflictingMaintenanceProcess)
      removePathIfExists(dataRoot)
    }
  },
  {timeout: 30_000},
)
