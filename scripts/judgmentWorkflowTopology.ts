import {randomUUID} from 'node:crypto'
import {existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {dirname, join, resolve} from 'node:path'

import {listen, serve, sleep, spawn, type Subprocess} from 'bun'

import {getJudgeWorkerCompletionReplayBarrierPaths} from '../src/server/cron/judgmentsJobs/judgeWorkerCompletionReplayBarrier.ts'
import {getJudgeWorkerLeaseLossTestBarrierPaths} from '../src/server/cron/judgmentsJobs/judgeWorkerLeaseLossTestBarrier.ts'
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
  journalPaths: string[]
  maintenancePort: number
  root: string
  serverStackLockPath: string
  expectedJudgeRestartPid?: number
}

export type JudgmentWorkflowTopologyProvider = {
  baseUrl: string
  close: () => void
  getEvidence: () => {maxConcurrentRequests: number; requestCount: number; renderedInputs: string[]}
  releaseFirstRequest: () => void
}

type RuntimeRole = 'api' | 'judge-worker' | 'maintenance-worker'
type RunningTopology = {process: Subprocess<'ignore', 'pipe', 'pipe'>; topology: JudgmentWorkflowTopology}
export type RunningTopologyExtraJudge = {
  env: Record<string, string>
  journalPath: string
  port: number
  process: Subprocess<'ignore', 'pipe', 'pipe'>
}
export type JudgmentWorkflowReadinessMonitor = {assertHealthy: () => void; stop: () => Promise<void>}

const startupTimeoutMs = 600_000
const shutdownTimeoutMs = 30_000

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
      FORSKA_TEST_JUDGE_CLAIM_LIMIT: '1',
      FORSKA_TEST_JUDGE_LEASE_LOSS_BARRIER_ROOT: join(root, 'lease-loss-barriers'),
      FORSKA_TEST_JUDGE_COMPLETION_BARRIER_ROOT: join(root, 'completion-replay-barriers'),
      FORSKA_TEST_JUDGMENT_TOPOLOGY_SEED_TOKEN: randomUUID(),
      JUDGE_WORKER_ID: workerId,
      LOG_DIR: join(root, 'logs'),
      NODE_ENV: 'test',
      RUN_SERVER_JUDGING: 'true',
    },
    judgePort,
    journalPath,
    journalPaths: [journalPath],
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
  topology.journalPaths.push(identity.journalPath)

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

export const startJudgmentWorkflowTopologyProvider = ({
  holdFirstRequest = false,
}: {holdFirstRequest?: boolean} = {}): JudgmentWorkflowTopologyProvider => {
  let activeRequests = 0
  let maxConcurrentRequests = 0
  let requestCount = 0
  const renderedInputs: string[] = []
  let releaseFirstRequest = () => {}
  const firstRequestRelease = new Promise<void>((resolveRelease) => {
    releaseFirstRequest = resolveRelease
  })
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
      const requestNumber = requestCount
      maxConcurrentRequests = Math.max(maxConcurrentRequests, activeRequests)
      const body = (await request.json()) as {messages?: Array<{content?: string; role?: string}>}
      renderedInputs.push(
        (body.messages ?? [])
          .map((message) => {
            return String(message.content ?? '')
          })
          .join('\n'),
      )
      // Leave enough time for the topology harness to observe and fence a claim
      // before this deterministic provider completes it. This is deliberately
      // longer than the evidence polling interval, while remaining negligible
      // compared with the production stale-claim recovery window.
      await sleep(1_000)
      if (holdFirstRequest && requestNumber === 1) {
        await firstRequestRelease
      }
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
    releaseFirstRequest,
  }
}

const postJson = async <T>(url: string, body: unknown, transientAttempt = 0): Promise<T> => {
  const response = await fetch(url, {
    body: JSON.stringify(body),
    headers: {'content-type': 'application/json'},
    method: 'POST',
  })
  const text = await response.text()

  if (!response.ok) {
    if (
      response.status === 500
      && text.includes('database is locked')
      && url.includes('/api/test/judgment-workflow-topology/')
      && transientAttempt < 100
    ) {
      await sleep(25)
      return postJson<T>(url, body, transientAttempt + 1)
    }
    throw new Error(`Topology request failed (${response.status}) ${url}: ${text}`)
  }

  return JSON.parse(text) as T
}

const patchJson = async <T>(url: string, body: unknown): Promise<T> => {
  const response = await fetch(url, {
    body: JSON.stringify(body),
    headers: {'content-type': 'application/json'},
    method: 'PATCH',
  })
  const text = await response.text()

  if (!response.ok) {
    throw new Error(`Topology request failed (${response.status}) ${url}: ${text}`)
  }

  return JSON.parse(text) as T
}

const waitUntil = async ({
  deadline,
  description,
  predicate,
}: {
  deadline: number
  description: string
  predicate: () => Promise<boolean> | boolean
}): Promise<void> => {
  if (await predicate()) return
  if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${description}`)
  await sleep(50)
  return waitUntil({deadline, description, predicate})
}

export const runJudgmentWorkflowTopologyReplay = async ({
  provider,
  topology,
}: {
  provider: JudgmentWorkflowTopologyProvider
  topology: JudgmentWorkflowTopology
}) => {
  const fixtureId = `topology-replay-${randomUUID()}`
  const token = topology.env.FORSKA_TEST_JUDGMENT_TOPOLOGY_SEED_TOKEN
  const ownerBaseUrl = `http://127.0.0.1:${topology.maintenancePort}${duckdbOwnerPrivateApiPrefix}`
  const seeded = await postJson<{data: {fixture: {projectIds: string[]}}}>(
    `${ownerBaseUrl}/api/test/judgment-workflow-topology/seed`,
    {fixtureId, providerBaseUrl: provider.baseUrl, singlePromptProjectA: true, token},
  )

  await waitUntil({
    deadline: Date.now() + 120_000,
    description: 'replay fixture serving queue',
    predicate: async () => {
      const evidence = await postJson<{data: {readyPairCount: number}}>(
        `${ownerBaseUrl}/api/test/judgment-workflow-topology/evidence`,
        {fixtureId, token},
      )
      return evidence.data.readyPairCount >= 3
    },
  })
  const job = await postJson<{data: {jobId: string}}>(`http://127.0.0.1:${topology.apiPort}/api/judgmentsjobs`, {
    projectId: seeded.data.fixture.projectIds[0],
  })
  let claimId = ''
  await waitUntil({
    deadline: Date.now() + 60_000,
    description: 'first provider request and owner claim',
    predicate: async () => {
      if (provider.getEvidence().requestCount < 1) return false
      const claims = await postJson<{data: {claims: Array<{claimId: string}>}}>(
        `${ownerBaseUrl}/api/test/judgment-workflow-topology/claims`,
        {jobId: job.data.jobId, token},
      )
      claimId = claims.data.claims[0]?.claimId ?? ''
      return claimId.length > 0
    },
  })
  const barrierRoot = topology.env.FORSKA_TEST_JUDGE_COMPLETION_BARRIER_ROOT
  if (!barrierRoot) throw new Error('Completion replay barrier root is missing')
  mkdirSync(barrierRoot, {recursive: true})
  const barrierPaths = getJudgeWorkerCompletionReplayBarrierPaths({claimId, root: barrierRoot})
  writeFileSync(barrierPaths.controlPath, `${claimId}\n`, {flag: 'wx'})
  provider.releaseFirstRequest()
  await waitUntil({
    deadline: Date.now() + 30_000,
    description: 'durable completion replay barrier',
    predicate: () => {
      return existsSync(barrierPaths.signalPath)
    },
  })
  const signal = JSON.parse(readFileSync(barrierPaths.signalPath, 'utf8')) as {pid: number}
  topology.expectedJudgeRestartPid = signal.pid
  process.kill(signal.pid, 'SIGKILL')
  await waitUntil({
    deadline: Date.now() + 10_000,
    description: 'terminated judge worker',
    predicate: () => {
      try {
        process.kill(signal.pid, 0)
        return false
      } catch {
        return true
      }
    },
  })
  await waitForRuntimeRole({deadline: Date.now() + startupTimeoutMs, port: topology.judgePort, role: 'judge-worker'})

  await waitUntil({
    deadline: Date.now() + 120_000,
    description: 'exact canonical replay judgments',
    predicate: async () => {
      const evidence = await postJson<{data: {judgments: Array<{count: number; projectId: string}>}}>(
        `${ownerBaseUrl}/api/test/judgment-workflow-topology/evidence`,
        {fixtureId, token},
      )
      return (
        evidence.data.judgments.length === 1
        && evidence.data.judgments[0]?.projectId === seeded.data.fixture.projectIds[0]
        && Number(evidence.data.judgments[0]?.count) === 1
      )
    },
  })

  if (provider.getEvidence().requestCount !== 1) {
    throw new Error(`Replay must not repeat provider inference: ${JSON.stringify(provider.getEvidence())}`)
  }

  return {claimId, jobId: job.data.jobId, restartedPid: signal.pid}
}

export const runJudgmentWorkflowTopologyLifecycle = async ({
  onDistinctJudgeOwners,
  onFirstJobClaimed,
  provider,
  topology,
}: {
  onDistinctJudgeOwners?: () => Promise<void> | void
  onFirstJobClaimed?: () => Promise<void>
  provider: JudgmentWorkflowTopologyProvider
  topology: JudgmentWorkflowTopology
}) => {
  const fixtureId = `topology-${randomUUID()}`
  const token = topology.env.FORSKA_TEST_JUDGMENT_TOPOLOGY_SEED_TOKEN
  const ownerBaseUrl = `http://127.0.0.1:${topology.maintenancePort}${duckdbOwnerPrivateApiPrefix}`
  const apiBaseUrl = `http://127.0.0.1:${topology.apiPort}`
  const observedClaims = new Map<string, Set<string>>()
  const observedJudgeIds = new Set<string>()
  let barrierReleased = false
  let distinctOwnersReported = false
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
  const firstJob = await postJson<{data: {jobId: string; status: string; storageState: string}}>(
    `${apiBaseUrl}/api/judgmentsjobs`,
    {projectId: seeded.data.fixture.projectIds[0]},
  )
  await waitUntil({
    deadline: Date.now() + 60_000,
    description: 'first job provider request and claim',
    predicate: async () => {
      if (provider.getEvidence().requestCount < 1) return false
      const claims = await postJson<{
        data: {claims: Array<{claimId: string; queueRecordId: string; serverId: string}>}
      }>(`${ownerBaseUrl}/api/test/judgment-workflow-topology/claims`, {jobId: firstJob.data.jobId, token})
      for (const claim of claims.data.claims) {
        observedJudgeIds.add(claim.serverId)
        observedClaims.set(claim.queueRecordId, new Set([claim.claimId]))
      }
      return claims.data.claims.length > 0
    },
  })
  await onFirstJobClaimed?.()
  const leaseLossBarrier = getJudgeWorkerLeaseLossTestBarrierPaths(topology.env)
  mkdirSync(dirname(leaseLossBarrier.pausePath), {recursive: true})
  writeFileSync(leaseLossBarrier.pausePath, 'pause\n', {flag: 'wx'})
  const secondJob = await postJson<{data: {jobId: string; status: string; storageState: string}}>(
    `${apiBaseUrl}/api/judgmentsjobs`,
    {projectId: seeded.data.fixture.projectIds[1]},
  )
  provider.releaseFirstRequest()
  await waitUntil({
    deadline: Date.now() + 30_000,
    description: 'post-provider lease-loss barrier',
    predicate: () => {
      return existsSync(leaseLossBarrier.reachedPath)
    },
  })
  const jobs = [firstJob, secondJob]
  const deadline = Date.now() + 240_000

  const waitForJudgments = async (): Promise<{
    jobEvidence: Array<{
      artifacts: {lease: boolean; shm: boolean; sqlite: boolean; wal: boolean}
      claims: Array<{claimId: string; queueRecordId: string; serverId: string; status: string}>
      health: {lastAckSeq: number | null; retainedRowCount: number}
      jobId: string
      scanState: {lastProjectRefreshAckSeq: number | null}
    }>
    judgments: Array<{
      count: number
      modelId: string
      projectId: string
      useAbstract: boolean
      useFulltext: boolean
      useFulltextNoImages: boolean
      useTitle: boolean
    }>
    migrationBoundary: {
      appliedMigrations: string[]
      sentinel: {
        completionTokens: number
        count: number
        promptTokens: number
        requestAttempts: string | null
        requests: number
        totalTokens: number
      }
    }
    visibleProjectionCount: number
  }> => {
    const evidence = await postJson<{
      data: {
        jobEvidence: Array<{
          artifacts: {lease: boolean; shm: boolean; sqlite: boolean; wal: boolean}
          claims: Array<{claimId: string; queueRecordId: string; serverId: string; status: string}>
          health: {lastAckSeq: number | null; retainedRowCount: number}
          jobId: string
          scanState: {lastProjectRefreshAckSeq: number | null}
        }>
        judgments: Array<{
          count: number
          modelId: string
          projectId: string
          useAbstract: boolean
          useFulltext: boolean
          useFulltextNoImages: boolean
          useTitle: boolean
        }>
        migrationBoundary: {
          appliedMigrations: string[]
          sentinel: {
            completionTokens: number
            count: number
            promptTokens: number
            requestAttempts: string | null
            requests: number
            totalTokens: number
          }
        }
        visibleProjectionCount: number
      }
    }>(`${ownerBaseUrl}/api/test/judgment-workflow-topology/evidence`, {
      fixtureId,
      jobIds: jobs.map((job) => {
        return job.data.jobId
      }),
      token,
    })

    for (const job of evidence.data.jobEvidence) {
      for (const claim of job.claims) {
        observedJudgeIds.add(claim.serverId)
        const claimIds = observedClaims.get(claim.queueRecordId) ?? new Set<string>()
        claimIds.add(claim.claimId)
        observedClaims.set(claim.queueRecordId, claimIds)
      }
    }
    const providerEvidence = provider.getEvidence()
    if (!barrierReleased && providerEvidence.requestCount >= 2) {
      writeFileSync(leaseLossBarrier.releasePath, 'release\n', {flag: 'wx'})
      barrierReleased = true
    }
    if (observedJudgeIds.size >= 2) {
      if (providerEvidence.maxConcurrentRequests !== 1) {
        throw new Error(
          `Provider admission exceeded its shared limit while both judges were live: ${JSON.stringify(providerEvidence)}`,
        )
      }
      if (!distinctOwnersReported) {
        distinctOwnersReported = true
        await onDistinctJudgeOwners?.()
      }
    }

    if (
      evidence.data.judgments.reduce((count, row) => {
        return count + Number(row.count)
      }, 0) === 4
      && evidence.data.visibleProjectionCount === 4
      && evidence.data.jobEvidence.every((job) => {
        return job.health.lastAckSeq !== null && job.health.lastAckSeq === job.scanState.lastProjectRefreshAckSeq
      })
    ) {
      return evidence.data
    }

    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for topology judgments: ${JSON.stringify(evidence.data)}`)
    }

    await sleep(100)
    return waitForJudgments()
  }

  const result = await waitForJudgments()

  if (
    !barrierReleased
    || !existsSync(leaseLossBarrier.reachedPath)
    || !existsSync(leaseLossBarrier.outcomePath)
    || !['missing', 'notHolder'].includes(readFileSync(leaseLossBarrier.outcomePath, 'utf8').trim())
    || observedJudgeIds.size !== 2
    || ![...observedClaims.values()].some((claimIds) => {
      return claimIds.size === 2
    })
    || [...observedClaims.values()].some((claimIds) => {
      return claimIds.size > 2
    })
  ) {
    throw new Error(
      `Topology did not prove distinct fenced judge ownership: ${JSON.stringify({
        observedClaims: [...observedClaims].map(([queueRecordId, claimIds]) => {
          return [queueRecordId, [...claimIds]]
        }),
        observedJudgeIds: [...observedJudgeIds],
      })}`,
    )
  }

  const pausedJobs = await Promise.all(
    jobs.map((job) => {
      return patchJson<{data: {status: string; storageState: string}}>(
        `${apiBaseUrl}/api/judgmentsjobs/${job.data.jobId}`,
        {status: 'paused'},
      )
    }),
  )

  if (
    pausedJobs.some((job) => {
      return job.data.status !== 'paused' || job.data.storageState !== 'draining'
    })
  ) {
    throw new Error(`Topology pause did not enter draining storage: ${JSON.stringify(pausedJobs)}`)
  }

  let drainedEvidence = result
  await waitUntil({
    deadline: Date.now() + 120_000,
    description: 'drained jobs and production SQLite cleanup',
    predicate: async () => {
      await postJson(`${ownerBaseUrl}/api/test/judgment-workflow-topology/cleanup-stale`, {token})
      drainedEvidence = await postJson<{data: typeof result}>(
        `${ownerBaseUrl}/api/test/judgment-workflow-topology/evidence`,
        {
          fixtureId,
          jobIds: jobs.map((job) => {
            return job.data.jobId
          }),
          token,
        },
      ).then((response) => {
        return response.data
      })
      const states = await Promise.all(
        jobs.map((job) => {
          return fetch(`${apiBaseUrl}/api/judgmentsjobs/${job.data.jobId}`).then(async (response) => {
            return (await response.json()) as {storageState?: string}
          })
        }),
      )

      return (
        states.every((state) => {
          return state.storageState === 'drained'
        })
        && drainedEvidence.jobEvidence.every((job) => {
          return !job.artifacts.sqlite && !job.artifacts.wal && !job.artifacts.shm && !job.artifacts.lease
        })
      )
    },
  })

  return {
    drainedEvidence,
    fixture: seeded.data.fixture,
    jobs,
    observedJudgeIds: [...observedJudgeIds],
    providerEvidence: provider.getEvidence,
    result,
  }
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

export const startJudgmentWorkflowReadinessMonitor = ({
  extraJudge,
  topology,
}: {
  extraJudge?: RunningTopologyExtraJudge
  topology: JudgmentWorkflowTopology
}): JudgmentWorkflowReadinessMonitor => {
  const targets = [
    {port: topology.apiPort, role: 'api' as const},
    {port: topology.maintenancePort, role: 'maintenance-worker' as const},
    {port: topology.judgePort, role: 'judge-worker' as const},
    ...(extraJudge ? [{port: extraJudge.port, role: 'judge-worker' as const}] : []),
  ]
  let stopped = false
  let failure: Error | null = null
  const monitor = async (): Promise<void> => {
    while (!stopped && failure === null) {
      for (const target of targets) {
        const healthy = await fetch(`http://127.0.0.1:${target.port}${runtimeReadyPath}`)
          .then(async (response) => {
            const body = (await response.json()) as {data?: {ready?: boolean; role?: string}}
            return response.ok && body.data?.ready === true && body.data.role === target.role
          })
          .catch(() => {
            return false
          })

        if (!healthy) {
          failure = new Error(`Runtime readiness regressed for ${target.role} on port ${target.port}`)
          return
        }
      }
      await sleep(100)
    }
  }
  const monitorPromise = monitor()

  return {
    assertHealthy: () => {
      if (failure) throw failure
    },
    stop: async () => {
      stopped = true
      await monitorPromise
      if (failure) throw failure
    },
  }
}

export const startJudgmentWorkflowTopology = async ({
  cwd = process.cwd(),
  topology = createJudgmentWorkflowTopology({cwd}),
}: {cwd?: string; topology?: JudgmentWorkflowTopology} = {}): Promise<RunningTopology> => {
  let serverStackProcess: Subprocess<'ignore', 'pipe', 'pipe'>

  try {
    serverStackProcess = spawn([process.execPath, 'scripts/startServerStack.ts'], {
      cwd,
      env: topology.env,
      stderr: 'pipe',
      stdin: 'ignore',
      stdout: 'pipe',
    })
  } catch (error) {
    rmSync(topology.serverStackLockPath, {force: true})
    rmSync(topology.root, {force: true, recursive: true})
    throw error
  }
  const deadline = Date.now() + startupTimeoutMs

  try {
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
  } catch (error) {
    if (serverStackProcess.exitCode === null) {
      serverStackProcess.kill('SIGTERM')
      await Promise.race([serverStackProcess.exited, sleep(shutdownTimeoutMs)])
    }
    if (serverStackProcess.exitCode === null) {
      serverStackProcess.kill('SIGKILL')
      await serverStackProcess.exited
    }
    rmSync(topology.serverStackLockPath, {force: true})
    rmSync(topology.root, {force: true, recursive: true})
    throw error
  }

  return {process: serverStackProcess, topology}
}

export const prepareJudgmentWorkflowMigrationBoundary = async (topology: JudgmentWorkflowTopology) => {
  const preparation = spawn(
    [process.execPath, 'scripts/prepareJudgmentWorkflowMigrationBoundary.ts', topology.duckdbPath],
    {
      cwd: process.cwd(),
      env: {
        ...topology.env,
        API_SERVER_PORT: String(topology.maintenancePort),
        FORSKA_RUNTIME_SERVICE: 'maintenance-worker-server',
        SERVER_DUCKDB_OWNER_URL: '',
        SERVER_ROLE: 'maintenance-worker',
      },
      stderr: 'pipe',
      stdin: 'ignore',
      stdout: 'pipe',
    },
  )
  const [exitCode, stderr] = await Promise.all([preparation.exited, new Response(preparation.stderr).text()])

  if (exitCode !== 0) {
    rmSync(topology.root, {force: true, recursive: true})
    throw new Error(`Failed to prepare migration-boundary topology database: ${stderr}`)
  }
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
    const supervisorEvents = readdirSync(join(topology.root, 'logs'))
      .filter((path) => {
        return path.endsWith('.jsonl')
      })
      .flatMap((path) => {
        return readFileSync(join(topology.root, 'logs', path), 'utf8').split('\n')
      })
      .flatMap((line) => {
        try {
          const event = JSON.parse(line) as {attrs?: {pid?: number; role?: string}; event?: string}
          return event.event?.startsWith('server.stack.') || event.event === 'duckdb.owner.takeover' ? [event] : []
        } catch {
          return []
        }
      })
    const expectedRestartEvents = supervisorEvents.filter((event) => {
      return (
        event.event === 'server.stack.managed-process-unexpected-exit'
        && event.attrs?.role === 'judge'
        && event.attrs.pid === topology.expectedJudgeRestartPid
      )
    })
    const unexpectedSupervisorEvents = supervisorEvents.filter((event) => {
      return !expectedRestartEvents.includes(event)
    })

    if (unexpectedSupervisorEvents.length > 0) {
      throw new Error(
        `Production topology observed unexpected supervisor events: ${JSON.stringify(unexpectedSupervisorEvents[0])}`,
      )
    }
    if (topology.expectedJudgeRestartPid !== undefined && expectedRestartEvents.length !== 1) {
      throw new Error(`Production topology did not record exactly one synchronized judge restart`)
    }
    const runtimePids = readdirSync(join(topology.root, 'logs'))
      .filter((path) => {
        return path.endsWith('.jsonl')
      })
      .flatMap((path) => {
        return readFileSync(join(topology.root, 'logs', path), 'utf8').split('\n')
      })
      .flatMap((line) => {
        try {
          const pid = (JSON.parse(line) as {runtime?: {pid?: number}}).runtime?.pid
          return typeof pid === 'number' ? [pid] : []
        } catch {
          return []
        }
      })
    const liveChildPids = [...new Set(runtimePids)].filter((pid) => {
      try {
        process.kill(pid, 0)
        return true
      } catch {
        return false
      }
    })

    if (liveChildPids.length > 0) {
      throw new Error(`Production topology left child processes alive after shutdown: ${liveChildPids.join(', ')}`)
    }
    const missingJournals = topology.journalPaths.filter((path) => {
      return !existsSync(path)
    })

    if (missingJournals.length > 0) {
      throw new Error(`Production topology did not persist expected judge journals: ${missingJournals.join(', ')}`)
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
