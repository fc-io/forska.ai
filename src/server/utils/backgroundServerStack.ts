import {existsSync} from 'node:fs'
import {totalmem} from 'node:os'

import {DuckDBInstance} from '@duckdb/node-api'

import {DEFAULT_API_SERVER_PORT} from '../../utils/runtimePortDefaults.ts'
import {getConfiguredDuckdbPath} from './getDuckdbPath.ts'
import {type LocalAppSettings, readLocalAppSettings} from './localAppSettings.ts'

type BackgroundServerRole = 'api' | 'maintenance-worker'

type BackgroundServerStackConfig = {
  apiPort: number
  duckdbOwnerUrl: string
  maintenanceDuckdbMemoryLimit: string
  maintenancePort: number
}

const mebibyte = 1024 ** 2
const darwinMaximumBackgroundWorkerDuckdbMemoryLimitMiB = 6400
const defaultMaximumBackgroundWorkerDuckdbMemoryLimitMiB = 20 * 1024
const minimumBackgroundWorkerDuckdbMemoryLimitMiB = 4 * 1024

const getIntegerPort = (value: string | undefined, fallback: number) => {
  const parsed = Number.parseInt(String(value ?? '').trim(), 10)

  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback
}

const getTrimmedValue = (value: string | null | undefined) => {
  const normalized = String(value ?? '').trim()

  return normalized === '' ? null : normalized
}

export const getDefaultBackgroundMaintenanceDuckdbMemoryLimit = (
  totalMemoryBytes = totalmem(),
  platform = process.platform,
) => {
  const totalMemoryMiB = Math.floor(totalMemoryBytes / mebibyte)
  const derivedLimitMiB = Math.floor(totalMemoryMiB / 2)
  const maximumBackgroundWorkerDuckdbMemoryLimitMiB =
    platform === 'darwin'
      ? darwinMaximumBackgroundWorkerDuckdbMemoryLimitMiB
      : defaultMaximumBackgroundWorkerDuckdbMemoryLimitMiB
  const maintenanceDuckdbMemoryLimitMiB = Math.max(
    minimumBackgroundWorkerDuckdbMemoryLimitMiB,
    Math.min(maximumBackgroundWorkerDuckdbMemoryLimitMiB, derivedLimitMiB),
  )

  return maintenanceDuckdbMemoryLimitMiB % 1024 === 0
    ? `${maintenanceDuckdbMemoryLimitMiB / 1024}GB`
    : `${maintenanceDuckdbMemoryLimitMiB}MiB`
}

export const getBackgroundServerStackConfig = (
  envValues: Record<string, string | undefined> = process.env,
  localAppSettings: LocalAppSettings = readLocalAppSettings(),
): BackgroundServerStackConfig => {
  const apiPort = getIntegerPort(envValues.API_SERVER_PORT, DEFAULT_API_SERVER_PORT)
  const maintenancePort = getIntegerPort(envValues.BACKGROUND_MAINTENANCE_PORT, apiPort + 1)
  const maintenanceDuckdbMemoryLimit =
    getTrimmedValue(envValues.BACKGROUND_MAINTENANCE_DUCKDB_MEMORY_LIMIT)
    ?? getTrimmedValue(envValues.DUCKDB_MEMORY_LIMIT)
    ?? getTrimmedValue(localAppSettings.backgroundWriterDuckdbMemoryLimit)
    ?? getDefaultBackgroundMaintenanceDuckdbMemoryLimit()

  return {apiPort, duckdbOwnerUrl: `http://127.0.0.1:${maintenancePort}`, maintenanceDuckdbMemoryLimit, maintenancePort}
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
  const maintenancePort = getIntegerPort(envValues.BACKGROUND_MAINTENANCE_PORT, apiPort + 1)
  const storedWorkerDuckdbMemoryLimit = await getStoredBackgroundWorkerDuckdbMemoryLimitFromDb(envValues)
  const maintenanceDuckdbMemoryLimit =
    getTrimmedValue(envValues.BACKGROUND_MAINTENANCE_DUCKDB_MEMORY_LIMIT)
    ?? getTrimmedValue(envValues.DUCKDB_MEMORY_LIMIT)
    ?? storedWorkerDuckdbMemoryLimit
    ?? getTrimmedValue(localAppSettings.backgroundWriterDuckdbMemoryLimit)
    ?? getDefaultBackgroundMaintenanceDuckdbMemoryLimit()

  return {apiPort, duckdbOwnerUrl: `http://127.0.0.1:${maintenancePort}`, maintenanceDuckdbMemoryLimit, maintenancePort}
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
        SERVER_DUCKDB_OWNER_URL: config.duckdbOwnerUrl,
      }
    : {
        ...resolvedBaseEnv,
        API_SERVER_PORT: String(config.maintenancePort),
        DUCKDB_MEMORY_LIMIT: config.maintenanceDuckdbMemoryLimit,
        FORSKA_RUNTIME_SERVICE: 'maintenance-worker-server',
        SERVER_ROLE: 'maintenance-worker',
        SERVER_DUCKDB_OWNER_URL: '',
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
        SERVER_DUCKDB_OWNER_URL: config.duckdbOwnerUrl,
      }
    : {
        ...resolvedBaseEnv,
        API_SERVER_PORT: String(config.maintenancePort),
        DUCKDB_MEMORY_LIMIT: config.maintenanceDuckdbMemoryLimit,
        FORSKA_RUNTIME_SERVICE: 'maintenance-worker-server',
        SERVER_ROLE: 'maintenance-worker',
        SERVER_DUCKDB_OWNER_URL: '',
      }
}
