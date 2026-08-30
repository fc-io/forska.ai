import {existsSync, mkdirSync, rmSync, writeFileSync} from 'node:fs'
import {dirname, isAbsolute, join} from 'node:path'

import {afterEach, expect, test} from 'bun:test'

import {
  getJudgeWorkerLeaseLossTestBarrierPaths,
  getJudgeWorkerLeaseLossTestClaimLimit,
  isJudgeWorkerLeaseLossTestBarrierActive,
  waitAtJudgeWorkerLeaseLossTestBarrier,
} from '../src/server/cron/judgmentsJobs/judgeWorkerLeaseLossTestBarrier.ts'
import {resolveJudgeWorkerJournalIdentity} from '../src/server/utils/judgeWorkerJournalIdentity.ts'
import {
  createJudgmentWorkflowTopology,
  isExpectedTopologyShutdownExitCode,
  startJudgmentWorkflowTopology,
} from './judgmentWorkflowTopology.ts'

const topologyRoots: string[] = []

afterEach(() => {
  topologyRoots.splice(0).map((root) => {
    rmSync(root, {force: true, recursive: true})
  })
})

test('topology environment isolates production state and provider credentials', () => {
  const topology = createJudgmentWorkflowTopology({
    envValues: {CODEX_API_KEY: 'must-not-leak', HOME: '/normal/profile', OPENAI_API_KEY: 'must-not-leak', PATH: '/bin'},
  })
  topologyRoots.push(topology.root)

  expect(topology.env).toMatchObject({
    API_SERVER_PORT: String(topology.apiPort),
    BACKGROUND_JUDGE_PORT: String(topology.judgePort),
    BACKGROUND_MAINTENANCE_PORT: String(topology.maintenancePort),
    DUCKDB_PATH: topology.duckdbPath,
    NODE_ENV: 'test',
    PATH: '/bin',
  })
  expect(typeof topology.env.JUDGE_WORKER_ID).toBe('string')
  expect(topology.env.FORSKA_TEST_JUDGE_LEASE_LOSS_BARRIER_ROOT).toBe(join(topology.root, 'lease-loss-barriers'))
  expect(getJudgeWorkerLeaseLossTestClaimLimit(16, topology.env)).toBe(1)
  expect(getJudgeWorkerLeaseLossTestClaimLimit(16, {...topology.env, NODE_ENV: 'production'})).toBe(16)
  expect(topology.env.HOME).toBeUndefined()
  expect(topology.env.CODEX_API_KEY).toBeUndefined()
  expect(topology.env.OPENAI_API_KEY).toBeUndefined()
  expect(new Set([topology.apiPort, topology.maintenancePort, topology.judgePort]).size).toBe(3)
  expect(isAbsolute(topology.duckdbPath)).toBe(true)
  expect(topology.env.DUCKDB_TEMP_DIRECTORY).not.toBe(dirname(topology.duckdbPath))
})

test('topology derives a production-valid durable journal from DuckDB and worker identity', () => {
  const topology = createJudgmentWorkflowTopology()
  topologyRoots.push(topology.root)
  const identity = resolveJudgeWorkerJournalIdentity({envValues: topology.env})

  expect(identity).toEqual({
    journalPath: topology.journalPath,
    lockPath: `${topology.journalPath}.lock`,
    source: 'worker-id',
    workerId: identity.workerId,
  })
  expect(identity.journalPath).toBe(
    join(dirname(topology.duckdbPath), 'judge-worker-journals', `${identity.workerId}.sqlite`),
  )
  expect(existsSync(topology.root)).toBe(true)
})

test('topology lease-loss barrier is opt-in, worker-specific, and test-only', async () => {
  const topology = createJudgmentWorkflowTopology()
  topologyRoots.push(topology.root)
  const paths = getJudgeWorkerLeaseLossTestBarrierPaths(topology.env)

  expect(isJudgeWorkerLeaseLossTestBarrierActive(topology.env)).toBe(false)
  mkdirSync(dirname(paths.pausePath), {recursive: true})
  writeFileSync(paths.pausePath, 'pause\n')
  expect(isJudgeWorkerLeaseLossTestBarrierActive(topology.env)).toBe(true)
  expect(isJudgeWorkerLeaseLossTestBarrierActive({...topology.env, JUDGE_WORKER_ID: 'different-worker'})).toBe(false)
  expect(isJudgeWorkerLeaseLossTestBarrierActive({...topology.env, NODE_ENV: 'production'})).toBe(false)
  const waitForRelease = waitAtJudgeWorkerLeaseLossTestBarrier(topology.env)
  expect(existsSync(paths.reachedPath)).toBe(true)
  writeFileSync(paths.releasePath, 'release\n')
  expect(await waitForRelease).toBe(true)
})

test('topology resolves the production supervisor lock outside the disposable app-data root', () => {
  const topology = createJudgmentWorkflowTopology()
  topologyRoots.push(topology.root)

  expect(topology.serverStackLockPath.startsWith(topology.root)).toBe(false)
  expect(topology.serverStackLockPath).toEndWith(
    `${topology.apiPort}-${topology.maintenancePort}-${topology.judgePort}.lock.json`,
  )
})

test('topology accepts Bun Windows SIGTERM exit status only for intentional shutdown', () => {
  expect(isExpectedTopologyShutdownExitCode({exitCode: 0, platform: 'win32'})).toBe(true)
  expect(isExpectedTopologyShutdownExitCode({exitCode: 143, platform: 'win32'})).toBe(true)
  expect(isExpectedTopologyShutdownExitCode({exitCode: 143, platform: 'linux'})).toBe(false)
  expect(isExpectedTopologyShutdownExitCode({exitCode: 1, platform: 'win32'})).toBe(false)
})

test('topology removes its disposable root when the production stack cannot be spawned', async () => {
  const topology = createJudgmentWorkflowTopology()

  expect(startJudgmentWorkflowTopology({cwd: join(topology.root, 'missing-cwd'), topology})).rejects.toThrow()
  expect(existsSync(topology.root)).toBe(false)
  expect(existsSync(topology.serverStackLockPath)).toBe(false)
})
