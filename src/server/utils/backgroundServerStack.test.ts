import {readFileSync} from 'node:fs'
import {rm} from 'node:fs/promises'
import {join} from 'node:path'

import {DuckDBInstance} from '@duckdb/node-api'
import {expect, test} from 'bun:test'

import {
  getBackgroundServerEnv,
  getBackgroundServerEnvAsync,
  getBackgroundServerStackConfig,
  getBackgroundServerStackConfigAsync,
  getDefaultBackgroundMaintenanceDuckdbMemoryLimit,
} from './backgroundServerStack.ts'

const gibibyte = 1024 ** 3
const projectRoot = process.cwd()
const defaultLocalAppSettings = {
  maintenanceWorkerDuckdbMemoryLimit: null,
  codexBin: null,
  duckdbBin: null,
  projectMartLargeRebuildBatchSize: null,
  projectMartLargeRebuildMaxCyclesPerWake: null,
  projectMartLargeRebuildMaxWakeMs: null,
  projectMartLargeRebuildPollIntervalMs: null,
  projectMartLargeRebuildTuningMode: 'automatic' as const,
}

test('background server stack keeps direct DuckDB access behind shared utilities', () => {
  const source = readFileSync(join(projectRoot, 'src/server/utils/backgroundServerStack.ts'), 'utf8')

  expect(source).not.toContain('@duckdb/node-api')
  expect(source).toContain('runEphemeralReadOnlyDuckdbFileJsonQuery')
})

test('background server stack derives a low-memory maintenance-worker DuckDB limit', () => {
  expect(getDefaultBackgroundMaintenanceDuckdbMemoryLimit(8 * gibibyte, 'linux')).toBe('4GB')
})

test('background server stack derives a mid-memory maintenance-worker DuckDB limit', () => {
  expect(getDefaultBackgroundMaintenanceDuckdbMemoryLimit(16 * gibibyte, 'linux')).toBe('8GB')
})

test('background server stack derives a higher-memory maintenance-worker DuckDB limit', () => {
  expect(getDefaultBackgroundMaintenanceDuckdbMemoryLimit(64 * gibibyte, 'linux')).toBe('20GB')
})

test('background server stack clamps darwin maintenance-worker DuckDB memory to the stable ceiling', () => {
  expect(getDefaultBackgroundMaintenanceDuckdbMemoryLimit(32 * gibibyte, 'darwin')).toBe('6400MiB')
})

test('background server stack defaults maintenance-worker port to api port plus one', () => {
  expect(getBackgroundServerStackConfig({API_SERVER_PORT: '3001'}, defaultLocalAppSettings)).toEqual({
    apiPort: 3001,
    judgePort: 3003,
    maintenanceDuckdbMemoryLimit: getDefaultBackgroundMaintenanceDuckdbMemoryLimit(),
    maintenancePort: 3002,
    duckdbOwnerUrl: 'http://127.0.0.1:3002',
  })
})

test('background server stack honors an explicit maintenance-worker port override', () => {
  expect(
    getBackgroundServerStackConfig(
      {API_SERVER_PORT: '4100', BACKGROUND_MAINTENANCE_PORT: '5100'},
      defaultLocalAppSettings,
    ),
  ).toEqual({
    apiPort: 4100,
    judgePort: 5101,
    maintenanceDuckdbMemoryLimit: getDefaultBackgroundMaintenanceDuckdbMemoryLimit(),
    maintenancePort: 5100,
    duckdbOwnerUrl: 'http://127.0.0.1:5100',
  })
})

test('background server stack honors an explicit maintenance-worker DuckDB memory override', () => {
  expect(
    getBackgroundServerStackConfig(
      {API_SERVER_PORT: '4100', BACKGROUND_MAINTENANCE_DUCKDB_MEMORY_LIMIT: '1536MiB', DUCKDB_MEMORY_LIMIT: '20GB'},
      defaultLocalAppSettings,
    ),
  ).toEqual({
    apiPort: 4100,
    judgePort: 4102,
    maintenanceDuckdbMemoryLimit: '1536MiB',
    maintenancePort: 4101,
    duckdbOwnerUrl: 'http://127.0.0.1:4101',
  })
})

test('background server stack falls back to the base duckdb memory limit when provided', () => {
  expect(
    getBackgroundServerStackConfig({API_SERVER_PORT: '4100', DUCKDB_MEMORY_LIMIT: '2GB'}, defaultLocalAppSettings),
  ).toEqual({
    apiPort: 4100,
    judgePort: 4102,
    maintenanceDuckdbMemoryLimit: '2GB',
    maintenancePort: 4101,
    duckdbOwnerUrl: 'http://127.0.0.1:4101',
  })
})

test('background server stack honors machine-local maintenance-worker DuckDB memory settings when env is unset', () => {
  expect(
    getBackgroundServerStackConfig(
      {API_SERVER_PORT: '4100'},
      {
        maintenanceWorkerDuckdbMemoryLimit: '12GB',
        codexBin: null,
        duckdbBin: null,
        projectMartLargeRebuildBatchSize: null,
        projectMartLargeRebuildMaxCyclesPerWake: null,
        projectMartLargeRebuildMaxWakeMs: null,
        projectMartLargeRebuildPollIntervalMs: null,
        projectMartLargeRebuildTuningMode: 'automatic',
      },
    ),
  ).toEqual({
    apiPort: 4100,
    judgePort: 4102,
    maintenanceDuckdbMemoryLimit: '12GB',
    maintenancePort: 4101,
    duckdbOwnerUrl: 'http://127.0.0.1:4101',
  })
})

test('background server stack builds api env that proxies to the maintenance worker', () => {
  expect(
    getBackgroundServerEnv({
      baseEnv: {API_SERVER_PORT: '3301', BACKGROUND_MAINTENANCE_PORT: '3302'},
      localAppSettings: defaultLocalAppSettings,
      role: 'api',
    }),
  ).toMatchObject({API_SERVER_PORT: '3301', SERVER_ROLE: 'api', SERVER_DUCKDB_OWNER_URL: 'http://127.0.0.1:3302'})
})

test('background server stack builds maintenance-worker env on the sibling port', () => {
  expect(
    getBackgroundServerEnv({
      baseEnv: {API_SERVER_PORT: '3301', BACKGROUND_MAINTENANCE_PORT: '3302'},
      localAppSettings: defaultLocalAppSettings,
      role: 'maintenance-worker',
    }),
  ).toMatchObject({
    API_SERVER_PORT: '3302',
    DUCKDB_MEMORY_LIMIT: getDefaultBackgroundMaintenanceDuckdbMemoryLimit(),
    SERVER_ROLE: 'maintenance-worker',
    SERVER_DUCKDB_OWNER_URL: '',
  })
})

test('background server stack builds judge-worker env without DuckDB ownership', () => {
  expect(
    getBackgroundServerEnv({
      baseEnv: {
        API_SERVER_PORT: '3301',
        BACKGROUND_JUDGE_PORT: '3303',
        BACKGROUND_MAINTENANCE_PORT: '3302',
        JUDGE_WORKER_ID: 'test-judge-worker',
        JUDGE_WORKER_JOURNAL_PATH: 'data/custom/judge.sqlite',
      },
      localAppSettings: defaultLocalAppSettings,
      role: 'judge-worker',
    }),
  ).toMatchObject({
    API_SERVER_PORT: '3303',
    FORSKA_RUNTIME_SERVICE: 'judge-worker-server',
    JUDGE_WORKER_ID: 'test-judge-worker',
    JUDGE_WORKER_JOURNAL_PATH: '',
    SERVER_ROLE: 'judge-worker',
    SERVER_DUCKDB_OWNER_URL: 'http://127.0.0.1:3302',
  })
})

test('background server stack async judge-worker env clears inherited explicit journal paths', async () => {
  const env = await getBackgroundServerEnvAsync({
    baseEnv: {
      API_SERVER_PORT: '3301',
      BACKGROUND_JUDGE_PORT: '3303',
      BACKGROUND_MAINTENANCE_PORT: '3302',
      JUDGE_WORKER_ID: 'test-judge-worker',
      JUDGE_WORKER_JOURNAL_PATH: 'data/custom/judge.sqlite',
    },
    localAppSettings: defaultLocalAppSettings,
    role: 'judge-worker',
  })

  expect(env).toMatchObject({
    API_SERVER_PORT: '3303',
    JUDGE_WORKER_ID: 'test-judge-worker',
    JUDGE_WORKER_JOURNAL_PATH: '',
    SERVER_ROLE: 'judge-worker',
    SERVER_DUCKDB_OWNER_URL: 'http://127.0.0.1:3302',
  })
})

test('background server stack passes machine-local maintenance-worker DuckDB memory into maintenance-worker env', () => {
  expect(
    getBackgroundServerEnv({
      baseEnv: {API_SERVER_PORT: '3301', BACKGROUND_MAINTENANCE_PORT: '3302'},
      localAppSettings: {...defaultLocalAppSettings, maintenanceWorkerDuckdbMemoryLimit: '18GB'},
      role: 'maintenance-worker',
    }),
  ).toMatchObject({
    API_SERVER_PORT: '3302',
    DUCKDB_MEMORY_LIMIT: '18GB',
    SERVER_ROLE: 'maintenance-worker',
    SERVER_DUCKDB_OWNER_URL: '',
  })
})

test('background server stack async config reads maintenance-worker DuckDB memory from app.user_config', async () => {
  const duckdbPath = `/tmp/f1-background-server-stack-${Date.now()}.duckdb`
  const duckdbInstance = await DuckDBInstance.create(duckdbPath)
  const connection = await duckdbInstance.connect()

  await connection.run(`
    CREATE SCHEMA IF NOT EXISTS app;
    CREATE TABLE app.user_config (
      id VARCHAR PRIMARY KEY,
      maintenance_worker_duckdb_memory_limit VARCHAR
    );
    INSERT INTO app.user_config (id, maintenance_worker_duckdb_memory_limit)
    VALUES ('local-user', '14GB');
  `)
  connection.closeSync()
  duckdbInstance.closeSync()

  try {
    expect(
      await getBackgroundServerStackConfigAsync(
        {API_SERVER_PORT: '4100', DUCKDB_PATH: duckdbPath},
        defaultLocalAppSettings,
      ),
    ).toEqual({
      apiPort: 4100,
      judgePort: 4102,
      maintenanceDuckdbMemoryLimit: '14GB',
      maintenancePort: 4101,
      duckdbOwnerUrl: 'http://127.0.0.1:4101',
    })

    expect(
      await getBackgroundServerEnvAsync({
        baseEnv: {API_SERVER_PORT: '4100', DUCKDB_PATH: duckdbPath},
        localAppSettings: defaultLocalAppSettings,
        role: 'maintenance-worker',
      }),
    ).toMatchObject({
      API_SERVER_PORT: '4101',
      DUCKDB_MEMORY_LIMIT: '14GB',
      SERVER_ROLE: 'maintenance-worker',
      SERVER_DUCKDB_OWNER_URL: '',
    })
  } finally {
    await rm(duckdbPath, {force: true})
    await rm(`${duckdbPath}.wal`, {force: true})
  }
})
