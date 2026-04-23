import {existsSync, mkdirSync, rmSync} from 'node:fs'
import {join} from 'node:path'

import {expect, test} from 'bun:test'

import {getRuntimeProfileCommandEnv} from './runWithRuntimeProfile.ts'

type SpawnedProcess = ReturnType<typeof globalThis.Bun.spawn>
type RuntimeReadyBody = {data?: {ready?: boolean; role?: string}}

const removePathIfExists = (path: string) => {
  if (existsSync(path)) {
    rmSync(path, {force: true, recursive: true})
  }
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

test('stacked server launcher carries split-role port and journal identity wiring', () => {
  expect(getRuntimeProfileCommandEnv({mode: 'stacked-server', profileName: 'primary'})).toMatchObject({
    API_SERVER_PORT: '3001',
    BACKGROUND_JUDGE_PORT: '3003',
    BACKGROUND_MAINTENANCE_PORT: '3002',
    DUCKDB_PATH: 'data/runtime/primary/forska.duckdb',
    FORSKA_RUNTIME_PROFILE: 'primary',
    FORSKA_RUNTIME_SERVICE: 'dev-single-server',
    JUDGE_WORKER_ID: 'primary-judge-worker',
  })
})

test('server stack script starts api, maintenance-worker, and judge-worker together', async () => {
  const dataRoot = join(process.cwd(), 'data', 'runtime', `run-with-runtime-profile-stack-${Date.now()}`)
  const duckdbPath = join(dataRoot, 'forska.duckdb')
  const apiPort = 34760
  const maintenancePort = 34761
  const judgePort = 34762

  mkdirSync(dataRoot, {recursive: true})

  const stackProcess = globalThis.Bun.spawn(['bun', 'scripts/startServerStack.ts'], {
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
      VITE_PORT: '34759',
    },
    stderr: 'pipe',
    stdout: 'pipe',
  })

  try {
    const [apiReady, maintenanceReady, judgeReady] = await Promise.all([
      waitForRuntimeReady(apiPort, 20_000),
      waitForRuntimeReady(maintenancePort, 20_000),
      waitForRuntimeReady(judgePort, 20_000),
    ])

    expect(apiReady.data).toMatchObject({ready: true, role: 'api'})
    expect(maintenanceReady.data).toMatchObject({ready: true, role: 'maintenance-worker'})
    expect(judgeReady.data).toMatchObject({ready: true, role: 'judge-worker'})
  } finally {
    await stopProcess(stackProcess)
    removePathIfExists(dataRoot)
  }
})
