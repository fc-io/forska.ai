import {expect, test} from 'bun:test'

import {
  getBackgroundServerEnv,
  getBackgroundServerStackConfig,
  getDefaultBackgroundWorkerDuckdbMemoryLimit,
} from './backgroundServerStack.ts'

const gibibyte = 1024 ** 3
const defaultLocalAppSettings = {
  backgroundWriterDuckdbMemoryLimit: null,
  codexBin: null,
  duckdbBin: null,
  projectMartLargeRebuildBatchSize: null,
  projectMartLargeRebuildMaxCyclesPerWake: null,
  projectMartLargeRebuildPollIntervalMs: null,
  projectMartLargeRebuildTuningMode: 'automatic' as const,
}

test('background server stack derives a low-memory worker duckdb limit', () => {
  expect(getDefaultBackgroundWorkerDuckdbMemoryLimit(8 * gibibyte)).toBe('4GB')
})

test('background server stack derives a mid-memory worker duckdb limit', () => {
  expect(getDefaultBackgroundWorkerDuckdbMemoryLimit(16 * gibibyte)).toBe('8GB')
})

test('background server stack derives a higher-memory worker duckdb limit', () => {
  expect(getDefaultBackgroundWorkerDuckdbMemoryLimit(64 * gibibyte)).toBe('20GB')
})

test('background server stack defaults worker port to api port plus one', () => {
  expect(getBackgroundServerStackConfig({API_SERVER_PORT: '3001'}, defaultLocalAppSettings)).toEqual({
    apiPort: 3001,
    workerDuckdbMemoryLimit: getDefaultBackgroundWorkerDuckdbMemoryLimit(),
    workerPort: 3002,
    writerUrl: 'http://127.0.0.1:3002',
  })
})

test('background server stack honors an explicit worker port override', () => {
  expect(
    getBackgroundServerStackConfig({API_SERVER_PORT: '4100', BACKGROUND_WRITER_PORT: '5100'}, defaultLocalAppSettings),
  ).toEqual({
    apiPort: 4100,
    workerDuckdbMemoryLimit: getDefaultBackgroundWorkerDuckdbMemoryLimit(),
    workerPort: 5100,
    writerUrl: 'http://127.0.0.1:5100',
  })
})

test('background server stack honors an explicit worker duckdb memory override', () => {
  expect(
    getBackgroundServerStackConfig(
      {API_SERVER_PORT: '4100', BACKGROUND_WRITER_DUCKDB_MEMORY_LIMIT: '1536MiB', DUCKDB_MEMORY_LIMIT: '20GB'},
      defaultLocalAppSettings,
    ),
  ).toEqual({apiPort: 4100, workerDuckdbMemoryLimit: '1536MiB', workerPort: 4101, writerUrl: 'http://127.0.0.1:4101'})
})

test('background server stack falls back to the base duckdb memory limit when provided', () => {
  expect(
    getBackgroundServerStackConfig({API_SERVER_PORT: '4100', DUCKDB_MEMORY_LIMIT: '2GB'}, defaultLocalAppSettings),
  ).toEqual({apiPort: 4100, workerDuckdbMemoryLimit: '2GB', workerPort: 4101, writerUrl: 'http://127.0.0.1:4101'})
})

test('background server stack honors machine-local worker duckdb memory settings when env is unset', () => {
  expect(
    getBackgroundServerStackConfig(
      {API_SERVER_PORT: '4100'},
      {
        backgroundWriterDuckdbMemoryLimit: '12GB',
        codexBin: null,
        duckdbBin: null,
        projectMartLargeRebuildBatchSize: null,
        projectMartLargeRebuildMaxCyclesPerWake: null,
        projectMartLargeRebuildPollIntervalMs: null,
        projectMartLargeRebuildTuningMode: 'automatic',
      },
    ),
  ).toEqual({apiPort: 4100, workerDuckdbMemoryLimit: '12GB', workerPort: 4101, writerUrl: 'http://127.0.0.1:4101'})
})

test('background server stack builds api env that proxies to the worker', () => {
  expect(
    getBackgroundServerEnv({
      baseEnv: {API_SERVER_PORT: '3301', BACKGROUND_WRITER_PORT: '3302'},
      localAppSettings: defaultLocalAppSettings,
      role: 'api',
    }),
  ).toMatchObject({API_SERVER_PORT: '3301', SERVER_ROLE: 'api', SERVER_WRITER_URL: 'http://127.0.0.1:3302'})
})

test('background server stack builds worker env on the sibling port', () => {
  expect(
    getBackgroundServerEnv({
      baseEnv: {API_SERVER_PORT: '3301', BACKGROUND_WRITER_PORT: '3302'},
      localAppSettings: defaultLocalAppSettings,
      role: 'worker',
    }),
  ).toMatchObject({
    API_SERVER_PORT: '3302',
    DUCKDB_MEMORY_LIMIT: getDefaultBackgroundWorkerDuckdbMemoryLimit(),
    SERVER_ROLE: 'worker',
    SERVER_WRITER_URL: '',
  })
})

test('background server stack passes machine-local worker duckdb memory into worker env', () => {
  expect(
    getBackgroundServerEnv({
      baseEnv: {API_SERVER_PORT: '3301', BACKGROUND_WRITER_PORT: '3302'},
      localAppSettings: {...defaultLocalAppSettings, backgroundWriterDuckdbMemoryLimit: '18GB'},
      role: 'worker',
    }),
  ).toMatchObject({API_SERVER_PORT: '3302', DUCKDB_MEMORY_LIMIT: '18GB', SERVER_ROLE: 'worker', SERVER_WRITER_URL: ''})
})
