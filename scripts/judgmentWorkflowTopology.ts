import {randomUUID} from 'node:crypto'
import {existsSync, mkdirSync, readdirSync, readFileSync, rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join, resolve} from 'node:path'

import {listen, serve, sleep, spawn, type Subprocess} from 'bun'

import {duckdbOwnerPrivateApiPrefix} from '../src/server/routes/apiRouteClassification.ts'
import {getBackgroundServerEnv} from '../src/server/utils/backgroundServerStack.ts'
import {
  readJudgeWorkerJournalLock,
  resolveJudgeWorkerJournalIdentity,
} from '../src/server/utils/judgeWorkerJournalIdentity.ts'
import {runtimeReadyPath} from '../src/server/utils/runtimeReadyContract.ts'

export type JudgmentWorkflowTopology = {
  apiPort: number
  duckdbPath: string
  env: Record<string, string>
  judgePort: number
  journalPath: string
  maintenancePort: number
  root: string
  serverStackLockPath: string
}

export type JudgmentWorkflowTopologyProvider = {
  baseUrl: string
  close: () => void
  getEvidence: () => {maxConcurrentRequests: number; requestCount: number; renderedInputs: string[]}
}

type RuntimeRole = 'api' | 'judge-worker' | 'maintenance-worker'
type RunningTopology = {process: Subprocess<'ignore', 'pipe', 'pipe'>; topology: JudgmentWorkflowTopology}
export type RunningTopologyExtraJudge = {
  env: Record<string, string>
  journalPath: string
  port: number
  process: Subprocess<'ignore', 'pipe', 'pipe'>
}

const startupTimeoutMs = 180_000
const shutdownTimeoutMs = 20_000

const getAvailablePort = (): number => {
  const server = listen({hostname: '127.0.0.1', port: 0, socket: {data() {}}})
  const port = server.port
  server.stop(true)
  return port
}

const getDistinctPorts = (): [number, number, number] => {
  const ports = Array.from(new Set([getAvailablePort(), getAvailablePort(), getAvailablePort()]))

  return ports.length === 3 ? (ports as [number, number, number]) : getDistinctPorts()
}

const getAllowedHostEnvironment = (envValues: Record<string, string | undefined>) => {
  const allowedKeys = ['LANG', 'LC_ALL', 'PATH', 'SystemRoot', 'WINDIR'] as const

  return allowedKeys.reduce<Record<string, string>>((result, key) => {
    const value = envValues[key]

    return value === undefined ? result : {...result, [key]: value}
  }, {})
}

export const createJudgmentWorkflowTopology = ({
  cwd = process.cwd(),
  envValues = process.env,
}: {cwd?: string; envValues?: Record<string, string | undefined>} = {}): JudgmentWorkflowTopology => {
  const [apiPort, maintenancePort, judgePort] = getDistinctPorts()
  const root = resolve(cwd, '.tmp', `judgment-workflow-topology-${randomUUID()}`)
  const duckdbPath = join(root, 'data', 'forska.duckdb')
  const workerId = `topology-${randomUUID()}`
  const journalPath = join(root, 'data', 'judge-worker-journals', `${workerId}.sqlite`)
  const serverStackLockPath = join(
    tmpdir(),
    'forska-server-stack',
    `${apiPort}-${maintenancePort}-${judgePort}.lock.json`,
  )

  mkdirSync(join(root, 'data'), {recursive: true})
  mkdirSync(join(root, 'duckdb-spill'), {recursive: true})
  mkdirSync(join(root, 'logs'), {recursive: true})

  return {
    apiPort,
    duckdbPath,
    env: {
      ...getAllowedHostEnvironment(envValues),
      API_SERVER_PORT: String(apiPort),
      BACKGROUND_MAINTENANCE_DUCKDB_MEMORY_LIMIT: '10GB',
      BACKGROUND_JUDGE_PORT: String(judgePort),
      BACKGROUND_MAINTENANCE_PORT: String(maintenancePort),
      DUCKDB_PATH: duckdbPath,
      DUCKDB_TEMP_DIRECTORY: join(root, 'duckdb-spill'),
      FORSKA_RUNTIME_PROFILE: 'local',
      FORSKA_TEST_JUDGE_COMPLETION_BARRIER_ROOT: join(root, 'completion-replay-barriers'),
      FORSKA_TEST_JUDGMENT_TOPOLOGY_SEED_TOKEN: randomUUID(),
      JUDGE_WORKER_ID: workerId,
      LOG_DIR: join(root, 'logs'),
      NODE_ENV: 'test',
      RUN_SERVER_JUDGING: 'true',
    },
    judgePort,
    journalPath,
    maintenancePort,
    root,
    serverStackLockPath,
  }
}

export const startJudgmentWorkflowTopologyExtraJudge = async (
  topology: JudgmentWorkflowTopology,
): Promise<RunningTopologyExtraJudge> => {
  const port = getAvailablePort()
  const workerId = `topology-extra-${randomUUID()}`
  const env = getBackgroundServerEnv({
    baseEnv: {...topology.env, BACKGROUND_JUDGE_PORT: String(port)},
    role: 'judge-worker',
  }) as Record<string, string>
  env.JUDGE_WORKER_ID = workerId
  const identity = resolveJudgeWorkerJournalIdentity({envValues: env})

  if (
    env.SERVER_DUCKDB_OWNER_URL !== `http://127.0.0.1:${topology.maintenancePort}`
    || env.API_SERVER_PORT !== String(port)
    || identity.journalPath === topology.journalPath
  ) {
    throw new Error('Extra judge-worker environment does not preserve isolated production owner routing')
  }

  const childProcess = spawn([process.execPath, 'src/server/index.ts'], {
    cwd: process.cwd(),
    env,
    stderr: 'pipe',
    stdin: 'ignore',
    stdout: 'pipe',
  })
  const deadline = Date.now() + startupTimeoutMs

  await Promise.race([
    waitForRuntimeRole({deadline, port, role: 'judge-worker'}),
    childProcess.exited.then((exitCode) => {
      throw new Error(`Extra judge worker exited before readiness with code ${exitCode}`)
    }),
  ])

  return {env, journalPath: identity.journalPath, port, process: childProcess}
}

export const stopJudgmentWorkflowTopologyExtraJudge = async (extraJudge: RunningTopologyExtraJudge) => {
  extraJudge.process.kill('SIGTERM')
  const exitCode = await waitForExit(extraJudge.process)
  const journalLock = readJudgeWorkerJournalLock({envValues: extraJudge.env})

  if ((exitCode !== 0 && exitCode !== 143) || journalLock?.processAlive === true) {
    throw new Error(`Extra judge worker did not shut down cleanly (exit=${exitCode})`)
  }
}

export const startJudgmentWorkflowTopologyProvider = (): JudgmentWorkflowTopologyProvider => {
  let activeRequests = 0
  let maxConcurrentRequests = 0
  let requestCount = 0
  const renderedInputs: string[] = []
  const server = serve({
    fetch: async (request) => {
      const url = new URL(request.url)

      if (url.pathname === '/v1/models') {
        return Response.json({data: [{id: 'topology-deterministic', object: 'model'}], object: 'list'})
      }

      if (url.pathname !== '/v1/chat/completions') {
        return new Response('not found', {status: 404})
      }

      activeRequests += 1
      requestCount += 1
      maxConcurrentRequests = Math.max(maxConcurrentRequests, activeRequests)
      const body = (await request.json()) as {messages?: Array<{content?: string; role?: string}>}
      renderedInputs.push(
        (body.messages ?? [])
          .map((message) => {
            return String(message.content ?? '')
          })
          .join('\n'),
      )
      await sleep(30)
      activeRequests -= 1

      return Response.json({
        choices: [
          {
            finish_reason: 'stop',
            index: 0,
            message: {
              content: JSON.stringify({answer: 'yes', explanation: 'deterministic topology response', quotes: []}),
              role: 'assistant',
            },
          },
        ],
        created: Math.floor(Date.now() / 1_000),
        id: `topology-${requestCount}`,
        model: 'topology-deterministic',
        object: 'chat.completion',
        usage: {completion_tokens: 8, prompt_tokens: 16, total_tokens: 24},
      })
    },
    hostname: '127.0.0.1',
    port: 0,
  })

  return {
    baseUrl: `http://127.0.0.1:${server.port}/v1`,
    close: () => {
      void server.stop(true)
    },
    getEvidence: () => {
      return {maxConcurrentRequests, renderedInputs: [...renderedInputs], requestCount}
    },
  }
}

const postJson = async <T>(url: string, body: unknown): Promise<T> => {
  const response = await fetch(url, {
    body: JSON.stringify(body),
    headers: {'content-type': 'application/json'},
    method: 'POST',
  })
  const text = await response.text()

  if (!response.ok) {
    throw new Error(`Topology request failed (${response.status}) ${url}: ${text}`)
  }

  return JSON.parse(text) as T
}

export const runJudgmentWorkflowTopologyLifecycle = async ({
  provider,
  topology,
}: {
  provider: JudgmentWorkflowTopologyProvider
  topology: JudgmentWorkflowTopology
}) => {
  const fixtureId = `topology-${randomUUID()}`
  const token = topology.env.FORSKA_TEST_JUDGMENT_TOPOLOGY_SEED_TOKEN
  const ownerBaseUrl = `http://127.0.0.1:${topology.maintenancePort}${duckdbOwnerPrivateApiPrefix}`
  const apiBaseUrl = `http://127.0.0.1:${topology.apiPort}`
  const seeded = await postJson<{data: {fixture: {modelId: string; projectIds: string[]}}}>(
    `${ownerBaseUrl}/api/test/judgment-workflow-topology/seed`,
    {fixtureId, providerBaseUrl: provider.baseUrl, token},
  )
  const servingDeadline = Date.now() + 60_000
  const waitForServingQueue = async (): Promise<void> => {
    const evidence = await postJson<{data: {readyPairCount: number}}>(
      `${ownerBaseUrl}/api/test/judgment-workflow-topology/evidence`,
      {fixtureId, token},
    )

    if (evidence.data.readyPairCount === 4) {
      return
    }

    if (Date.now() >= servingDeadline) {
      throw new Error(`Timed out waiting for topology serving queue: ${JSON.stringify(evidence.data)}`)
    }

    await sleep(100)
    return waitForServingQueue()
  }
  await waitForServingQueue()
  const jobs = await Promise.all(
    seeded.data.fixture.projectIds.map((projectId) => {
      return postJson<{data: {jobId: string; status: string; storageState: string}}>(
        `${apiBaseUrl}/api/judgmentsjobs`,
        {projectId},
      )
    }),
  )
  const deadline = Date.now() + 120_000

  const waitForJudgments = async (): Promise<{
    judgments: Array<{
      count: number
      modelId: string
      projectId: string
      useAbstract: boolean
      useFulltext: boolean
      useFulltextNoImages: boolean
      useTitle: boolean
    }>
  }> => {
    const evidence = await postJson<{
      data: {
        judgments: Array<{
          count: number
          modelId: string
          projectId: string
          useAbstract: boolean
          useFulltext: boolean
          useFulltextNoImages: boolean
          useTitle: boolean
        }>
      }
    }>(`${ownerBaseUrl}/api/test/judgment-workflow-topology/evidence`, {fixtureId, token})

    if (
      evidence.data.judgments.reduce((count, row) => {
        return count + Number(row.count)
      }, 0) === 4
    ) {
      return evidence.data
    }

    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for topology judgments: ${JSON.stringify(evidence.data)}`)
    }

    await sleep(100)
    return waitForJudgments()
  }

  return {fixture: seeded.data.fixture, jobs, providerEvidence: provider.getEvidence, result: await waitForJudgments()}
}

const waitForRuntimeRole = async ({
  deadline,
  port,
  role,
}: {
  deadline: number
  port: number
  role: RuntimeRole
}): Promise<void> => {
  const ready = await fetch(`http://127.0.0.1:${port}${runtimeReadyPath}`)
    .then(async (response) => {
      const body = (await response.json()) as {data?: {ready?: boolean; role?: string}}

      return response.ok && body.data?.ready === true && body.data.role === role
    })
    .catch(() => {
      return false
    })

  if (ready) {
    return
  }

  if (Date.now() >= deadline) {
    throw new Error(`Timed out waiting for ${role} readiness on port ${port}`)
  }

  await sleep(100)
  return waitForRuntimeRole({deadline, port, role})
}

export const startJudgmentWorkflowTopology = async ({
  cwd = process.cwd(),
  topology = createJudgmentWorkflowTopology({cwd}),
}: {cwd?: string; topology?: JudgmentWorkflowTopology} = {}): Promise<RunningTopology> => {
  const serverStackProcess = spawn([process.execPath, 'scripts/startServerStack.ts'], {
    cwd,
    env: topology.env,
    stderr: 'pipe',
    stdin: 'ignore',
    stdout: 'pipe',
  })
  const deadline = Date.now() + startupTimeoutMs

  await Promise.race([
    Promise.all([
      waitForRuntimeRole({deadline, port: topology.apiPort, role: 'api'}),
      waitForRuntimeRole({deadline, port: topology.maintenancePort, role: 'maintenance-worker'}),
      waitForRuntimeRole({deadline, port: topology.judgePort, role: 'judge-worker'}),
    ]),
    serverStackProcess.exited.then((exitCode) => {
      throw new Error(`Production server stack exited before readiness with code ${exitCode}`)
    }),
  ])

  return {process: serverStackProcess, topology}
}

const waitForExit = async (serverStackProcess: Subprocess<'ignore', 'pipe', 'pipe'>): Promise<number> => {
  return Promise.race([
    serverStackProcess.exited,
    new Promise<never>((_resolve, reject) => {
      setTimeout(() => {
        reject(new Error('Production server stack did not exit after SIGTERM'))
      }, shutdownTimeoutMs)
    }),
  ])
}

export const stopJudgmentWorkflowTopology = async ({process: serverStackProcess, topology}: RunningTopology) => {
  serverStackProcess.kill('SIGTERM')

  try {
    const exitCode = await waitForExit(serverStackProcess)

    if (exitCode !== 0) {
      throw new Error(`Production server stack exited with code ${exitCode}`)
    }

    if (existsSync(topology.serverStackLockPath)) {
      throw new Error(`Production server stack lock was not released: ${topology.serverStackLockPath}`)
    }
    const unexpectedSupervisorEvents = readdirSync(join(topology.root, 'logs'))
      .filter((path) => {
        return path.endsWith('.jsonl')
      })
      .flatMap((path) => {
        return readFileSync(join(topology.root, 'logs', path), 'utf8').split('\n')
      })
      .filter((line) => {
        return (
          line.includes('server.stack.managed-process-unexpected-exit')
          || line.includes('server.stack.managed-process-watchdog-restart')
          || line.includes('duckdb.owner.takeover')
        )
      })

    if (unexpectedSupervisorEvents.length > 0) {
      throw new Error(`Production topology observed unexpected supervisor events: ${unexpectedSupervisorEvents[0]}`)
    }
  } finally {
    if (serverStackProcess.exitCode === null) {
      serverStackProcess.kill('SIGKILL')
      await serverStackProcess.exited
    }
    rmSync(topology.root, {force: true, recursive: true})
  }

  if (existsSync(topology.root)) {
    throw new Error(`Production topology root was not removed: ${topology.root}`)
  }
}
