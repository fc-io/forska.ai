import {existsSync} from 'node:fs'
import {totalmem} from 'node:os'

import {DuckDBInstance} from '@duckdb/node-api'

import {DEFAULT_API_SERVER_PORT} from '../../utils/runtimePortDefaults.ts'
import {getConfiguredDuckdbPath} from './getDuckdbPath.ts'
import {type LocalAppSettings, readLocalAppSettings} from './localAppSettings.ts'

type BackgroundServerRole = 'api' | 'worker'

type BackgroundServerStackConfig = {
  apiPort: number
  workerDuckdbMemoryLimit: string
  workerPort: number
  writerUrl: string
}

const gibibyte = 1024 ** 3
const minimumBackgroundWorkerDuckdbMemoryLimitGb = 4
const maximumBackgroundWorkerDuckdbMemoryLimitGb = 20

const getIntegerPort = (value: string | undefined, fallback: number) => {
  const parsed = Number.parseInt(String(value ?? '').trim(), 10)

  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback
}

const getTrimmedValue = (value: string | undefined) => {
  const normalized = String(value ?? '').trim()

  return normalized === '' ? null : normalized
}

export const getDefaultBackgroundWorkerDuckdbMemoryLimit = (totalMemoryBytes = totalmem()) => {
  const totalMemoryGb = Math.floor(totalMemoryBytes / gibibyte)
  const derivedLimitGb = Math.floor(totalMemoryGb / 2)
  const workerDuckdbMemoryLimitGb = Math.max(
    minimumBackgroundWorkerDuckdbMemoryLimitGb,
    Math.min(maximumBackgroundWorkerDuckdbMemoryLimitGb, derivedLimitGb),
  )

  return `${workerDuckdbMemoryLimitGb}GB`
}

export const getBackgroundServerStackConfig = (
  envValues: Record<string, string | undefined> = process.env,
  localAppSettings: LocalAppSettings = readLocalAppSettings(),
): BackgroundServerStackConfig => {
  const apiPort = getIntegerPort(envValues.API_SERVER_PORT, DEFAULT_API_SERVER_PORT)
  const workerPort = getIntegerPort(envValues.BACKGROUND_WRITER_PORT, apiPort + 1)
  const workerDuckdbMemoryLimit =
    getTrimmedValue(envValues.BACKGROUND_WRITER_DUCKDB_MEMORY_LIMIT)
    ?? getTrimmedValue(envValues.DUCKDB_MEMORY_LIMIT)
    ?? getTrimmedValue(localAppSettings.backgroundWriterDuckdbMemoryLimit)
    ?? getDefaultBackgroundWorkerDuckdbMemoryLimit()

  return {apiPort, workerDuckdbMemoryLimit, workerPort, writerUrl: `http://127.0.0.1:${workerPort}`}
}

const getStoredBackgroundWorkerDuckdbMemoryLimitFromDb = async (
  envValues: Record<string, string | undefined> = process.env,
): Promise<string | null> => {
  const duckdbPath = getConfiguredDuckdbPath({envValues})

  if (duckdbPath === ':memory:' || !existsSync(duckdbPath)) {
    return null
  }

  let duckdbInstance: DuckDBInstance | null = null

  try {
    duckdbInstance = await DuckDBInstance.create(duckdbPath, {access_mode: 'READ_ONLY'})
    const connection = await duckdbInstance.connect()
    const reader = await connection.runAndReadAll(`
      SELECT background_writer_duckdb_memory_limit AS value
      FROM app.user_config
      LIMIT 1
    `)
    const [row] = reader.getRowObjectsJson() as Array<{value?: unknown}>

    connection.closeSync()
    return getTrimmedValue(typeof row?.value === 'string' ? row.value : undefined)
  } catch {
    return null
  } finally {
    duckdbInstance?.closeSync()
  }
}

export const getBackgroundServerStackConfigAsync = async (
  envValues: Record<string, string | undefined> = process.env,
  localAppSettings: LocalAppSettings = readLocalAppSettings(),
): Promise<BackgroundServerStackConfig> => {
  const apiPort = getIntegerPort(envValues.API_SERVER_PORT, DEFAULT_API_SERVER_PORT)
  const workerPort = getIntegerPort(envValues.BACKGROUND_WRITER_PORT, apiPort + 1)
  const storedWorkerDuckdbMemoryLimit = await getStoredBackgroundWorkerDuckdbMemoryLimitFromDb(envValues)
  const workerDuckdbMemoryLimit =
    getTrimmedValue(envValues.BACKGROUND_WRITER_DUCKDB_MEMORY_LIMIT)
    ?? getTrimmedValue(envValues.DUCKDB_MEMORY_LIMIT)
    ?? storedWorkerDuckdbMemoryLimit
    ?? getTrimmedValue(localAppSettings.backgroundWriterDuckdbMemoryLimit)
    ?? getDefaultBackgroundWorkerDuckdbMemoryLimit()

  return {apiPort, workerDuckdbMemoryLimit, workerPort, writerUrl: `http://127.0.0.1:${workerPort}`}
}

export const getBackgroundServerEnv = ({
  baseEnv,
  localAppSettings,
  role,
}: {
  baseEnv?: Record<string, string | undefined>
  localAppSettings?: LocalAppSettings
  role: BackgroundServerRole
}) => {
  const resolvedBaseEnv = {...baseEnv, BUN_CONFIG_MAX_HTTP_REQUESTS: baseEnv?.BUN_CONFIG_MAX_HTTP_REQUESTS ?? '2048'}
  const config = getBackgroundServerStackConfig(resolvedBaseEnv, localAppSettings ?? readLocalAppSettings())

  return role === 'api'
    ? {
        ...resolvedBaseEnv,
        API_SERVER_PORT: String(config.apiPort),
        FORSKA_RUNTIME_SERVICE: 'api-server',
        SERVER_ROLE: 'api',
        SERVER_WRITER_URL: config.writerUrl,
      }
    : {
        ...resolvedBaseEnv,
        API_SERVER_PORT: String(config.workerPort),
        DUCKDB_MEMORY_LIMIT: config.workerDuckdbMemoryLimit,
        FORSKA_RUNTIME_SERVICE: 'worker-server',
        SERVER_ROLE: 'worker',
        SERVER_WRITER_URL: '',
      }
}

export const getBackgroundServerEnvAsync = async ({
  baseEnv,
  localAppSettings,
  role,
}: {
  baseEnv?: Record<string, string | undefined>
  localAppSettings?: LocalAppSettings
  role: BackgroundServerRole
}) => {
  const resolvedBaseEnv = {...baseEnv, BUN_CONFIG_MAX_HTTP_REQUESTS: baseEnv?.BUN_CONFIG_MAX_HTTP_REQUESTS ?? '2048'}
  const config = await getBackgroundServerStackConfigAsync(resolvedBaseEnv, localAppSettings ?? readLocalAppSettings())

  return role === 'api'
    ? {
        ...resolvedBaseEnv,
        API_SERVER_PORT: String(config.apiPort),
        FORSKA_RUNTIME_SERVICE: 'api-server',
        SERVER_ROLE: 'api',
        SERVER_WRITER_URL: config.writerUrl,
      }
    : {
        ...resolvedBaseEnv,
        API_SERVER_PORT: String(config.workerPort),
        DUCKDB_MEMORY_LIMIT: config.workerDuckdbMemoryLimit,
        FORSKA_RUNTIME_SERVICE: 'worker-server',
        SERVER_ROLE: 'worker',
        SERVER_WRITER_URL: '',
      }
}
