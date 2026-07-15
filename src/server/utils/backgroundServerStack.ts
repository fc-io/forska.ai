import {existsSync} from 'node:fs'

import {DEFAULT_API_SERVER_PORT} from '../../utils/runtimePortDefaults.ts'
import {runEphemeralReadOnlyDuckdbFileJsonQuery} from './duckdbEphemeralReadOnly.ts'
import {getDefaultMaintenanceDuckdbMemoryLimit} from './duckdbMemoryDefaults.ts'
import {getConfiguredDuckdbPath} from './getDuckdbPath.ts'
import {type LocalAppSettings, readLocalAppSettings} from './localAppSettings.ts'

type BackgroundServerRole = 'api' | 'judge-worker' | 'maintenance-worker'

type BackgroundServerStackConfig = {
  apiPort: number
  duckdbOwnerUrl: string
  judgePort: number
  maintenanceDuckdbMemoryLimit: string
  maintenancePort: number
}

const getIntegerPort = (value: string | undefined, fallback: number) => {
  const parsed = Number.parseInt(String(value ?? '').trim(), 10)

  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback
}

const getTrimmedValue = (value: string | null | undefined) => {
  const normalized = String(value ?? '').trim()

  return normalized === '' ? null : normalized
}

const getResolvedBackgroundBaseEnv = (
  baseEnv: Record<string, string | undefined> | undefined,
): Record<string, string | undefined> => {
  return {...(baseEnv ?? {}), BUN_CONFIG_MAX_HTTP_REQUESTS: baseEnv?.BUN_CONFIG_MAX_HTTP_REQUESTS ?? '2048'}
}

const getBackgroundServerProcessBaseEnv = (resolvedBaseEnv: Record<string, string | undefined>) => {
  return {...resolvedBaseEnv, JUDGE_WORKER_JOURNAL_PATH: ''}
}

export const getDefaultBackgroundMaintenanceDuckdbMemoryLimit = (totalMemoryBytes?: number, platform?: string) => {
  return getDefaultMaintenanceDuckdbMemoryLimit(totalMemoryBytes, platform)
}

export const getBackgroundServerStackConfig = (
  envValues: Record<string, string | undefined> = process.env,
  localAppSettings: LocalAppSettings = readLocalAppSettings(),
): BackgroundServerStackConfig => {
  const apiPort = getIntegerPort(envValues.API_SERVER_PORT, DEFAULT_API_SERVER_PORT)
  const maintenancePort = getIntegerPort(envValues.BACKGROUND_MAINTENANCE_PORT, apiPort + 1)
  const judgePort = getIntegerPort(envValues.BACKGROUND_JUDGE_PORT, maintenancePort + 1)
  const maintenanceDuckdbMemoryLimit =
    getTrimmedValue(envValues.BACKGROUND_MAINTENANCE_DUCKDB_MEMORY_LIMIT)
    ?? getTrimmedValue(envValues.DUCKDB_MEMORY_LIMIT)
    ?? getTrimmedValue(localAppSettings.maintenanceWorkerDuckdbMemoryLimit)
    ?? getDefaultBackgroundMaintenanceDuckdbMemoryLimit()

  return {
    apiPort,
    duckdbOwnerUrl: `http://127.0.0.1:${maintenancePort}`,
    judgePort,
    maintenanceDuckdbMemoryLimit,
    maintenancePort,
  }
}

const getStoredBackgroundMaintenanceDuckdbMemoryLimitFromDb = async (
  envValues: Record<string, string | undefined> = process.env,
): Promise<string | null> => {
  const duckdbPath = getConfiguredDuckdbPath({envValues})
  const workloadContext = {
    allowsTempSpill: true,
    fallbackIntent: 'reject' as const,
    routeOrJobKey: 'maintenance.backgroundServerStack.memoryLimitConfigRead',
    workloadClass: 'maintenance',
  }

  if (duckdbPath === ':memory:' || !existsSync(duckdbPath)) {
    return null
  }

  try {
    const [row] = await runEphemeralReadOnlyDuckdbFileJsonQuery<{value?: unknown}>({
      databasePath: duckdbPath,
      memoryLimit: envValues.DUCKDB_MEMORY_LIMIT,
      statement: `
      SELECT maintenance_worker_duckdb_memory_limit AS value
      FROM app.user_config
      LIMIT 1
    `,
      workloadContext,
    })

    return getTrimmedValue(typeof row?.value === 'string' ? row.value : undefined)
  } catch {
    return null
  }
}

export const getBackgroundServerStackConfigAsync = async (
  envValues: Record<string, string | undefined> = process.env,
  localAppSettings: LocalAppSettings = readLocalAppSettings(),
): Promise<BackgroundServerStackConfig> => {
  const apiPort = getIntegerPort(envValues.API_SERVER_PORT, DEFAULT_API_SERVER_PORT)
  const maintenancePort = getIntegerPort(envValues.BACKGROUND_MAINTENANCE_PORT, apiPort + 1)
  const judgePort = getIntegerPort(envValues.BACKGROUND_JUDGE_PORT, maintenancePort + 1)
  const storedMaintenanceDuckdbMemoryLimit = await getStoredBackgroundMaintenanceDuckdbMemoryLimitFromDb(envValues)
  const maintenanceDuckdbMemoryLimit =
    getTrimmedValue(envValues.BACKGROUND_MAINTENANCE_DUCKDB_MEMORY_LIMIT)
    ?? getTrimmedValue(envValues.DUCKDB_MEMORY_LIMIT)
    ?? storedMaintenanceDuckdbMemoryLimit
    ?? getTrimmedValue(localAppSettings.maintenanceWorkerDuckdbMemoryLimit)
    ?? getDefaultBackgroundMaintenanceDuckdbMemoryLimit()

  return {
    apiPort,
    duckdbOwnerUrl: `http://127.0.0.1:${maintenancePort}`,
    judgePort,
    maintenanceDuckdbMemoryLimit,
    maintenancePort,
  }
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
  const resolvedBaseEnv = getResolvedBackgroundBaseEnv(baseEnv)
  const backgroundServerBaseEnv = getBackgroundServerProcessBaseEnv(resolvedBaseEnv)
  const config = getBackgroundServerStackConfig(resolvedBaseEnv, localAppSettings ?? readLocalAppSettings())

  if (role === 'api') {
    return {
      ...backgroundServerBaseEnv,
      API_SERVER_PORT: String(config.apiPort),
      FORSKA_RUNTIME_SERVICE: 'api-server',
      SERVER_ROLE: 'api',
      SERVER_DUCKDB_OWNER_URL: config.duckdbOwnerUrl,
    }
  }

  return role === 'judge-worker'
    ? {
        ...backgroundServerBaseEnv,
        API_SERVER_PORT: String(config.judgePort),
        FORSKA_RUNTIME_SERVICE: 'judge-worker-server',
        SERVER_ROLE: 'judge-worker',
        SERVER_DUCKDB_OWNER_URL: config.duckdbOwnerUrl,
      }
    : {
        ...backgroundServerBaseEnv,
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
  const resolvedBaseEnv = getResolvedBackgroundBaseEnv(baseEnv)
  const backgroundServerBaseEnv = getBackgroundServerProcessBaseEnv(resolvedBaseEnv)
  const config = await getBackgroundServerStackConfigAsync(resolvedBaseEnv, localAppSettings ?? readLocalAppSettings())

  if (role === 'api') {
    return {
      ...backgroundServerBaseEnv,
      API_SERVER_PORT: String(config.apiPort),
      FORSKA_RUNTIME_SERVICE: 'api-server',
      SERVER_ROLE: 'api',
      SERVER_DUCKDB_OWNER_URL: config.duckdbOwnerUrl,
    }
  }

  return role === 'judge-worker'
    ? {
        ...backgroundServerBaseEnv,
        API_SERVER_PORT: String(config.judgePort),
        FORSKA_RUNTIME_SERVICE: 'judge-worker-server',
        SERVER_ROLE: 'judge-worker',
        SERVER_DUCKDB_OWNER_URL: config.duckdbOwnerUrl,
      }
    : {
        ...backgroundServerBaseEnv,
        API_SERVER_PORT: String(config.maintenancePort),
        DUCKDB_MEMORY_LIMIT: config.maintenanceDuckdbMemoryLimit,
        FORSKA_RUNTIME_SERVICE: 'maintenance-worker-server',
        SERVER_ROLE: 'maintenance-worker',
        SERVER_DUCKDB_OWNER_URL: '',
      }
}
