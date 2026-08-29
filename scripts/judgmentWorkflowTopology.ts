import {randomUUID} from 'node:crypto'
import {existsSync, mkdirSync, rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join, resolve} from 'node:path'

import {listen, sleep, spawn, type Subprocess} from 'bun'

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

type RuntimeRole = 'api' | 'judge-worker' | 'maintenance-worker'
type RunningTopology = {process: Subprocess<'ignore', 'pipe', 'pipe'>; topology: JudgmentWorkflowTopology}

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
      BACKGROUND_JUDGE_PORT: String(judgePort),
      BACKGROUND_MAINTENANCE_PORT: String(maintenancePort),
      DUCKDB_PATH: duckdbPath,
      DUCKDB_TEMP_DIRECTORY: join(root, 'duckdb-spill'),
      FORSKA_RUNTIME_PROFILE: 'local',
      JUDGE_WORKER_ID: workerId,
      LOG_DIR: join(root, 'logs'),
      NODE_ENV: 'test',
    },
    judgePort,
    journalPath,
    maintenancePort,
    root,
    serverStackLockPath,
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
  } finally {
    if (serverStackProcess.exitCode === null) {
      serverStackProcess.kill('SIGKILL')
      await serverStackProcess.exited
    }
    rmSync(topology.root, {force: true, recursive: true})
  }
}
