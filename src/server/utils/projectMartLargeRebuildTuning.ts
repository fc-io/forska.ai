import {totalmem} from 'node:os'

import {getAppDatabaseService} from '../services/appDatabaseService.ts'
import {getUserConfigQueryService} from '../services/userConfigQueryService.ts'
import {parseDuckdbMemoryLimitToMiB} from './duckdbMemoryLimit.ts'
import {type LocalAppSettings, readLocalAppSettings} from './localAppSettings.ts'

type ProjectMartLargeRebuildConfigSource = 'automatic' | 'env' | 'manual'
type ProjectMartLargeRebuildHeartbeatFieldSources = {
  batchSize: ProjectMartLargeRebuildConfigSource
  maxCyclesPerWake: ProjectMartLargeRebuildConfigSource
  maxWakeMs: ProjectMartLargeRebuildConfigSource
  pollIntervalMs: ProjectMartLargeRebuildConfigSource
}
type ProjectMartLargeRebuildAutomaticProfile = 'large' | 'medium' | 'small'
type StoredProjectMartLargeRebuildSettings = {
  maintenanceWorkerDuckdbMemoryLimit: string | null
  batchSize: number | null
  maxCyclesPerWake: number | null
  maxWakeMs: number | null
  pollIntervalMs: number | null
  tuningMode: LocalAppSettings['projectMartLargeRebuildTuningMode']
}

export type ProjectMartLargeRebuildAutomaticHeartbeatConfig = {
  activeLargeRebuildProjectCount: number
  batchSize: number
  maxCyclesPerWake: number
  maxWakeMs: number
  pollIntervalMs: number
  profile: ProjectMartLargeRebuildAutomaticProfile
  totalMemoryGb: number
}

export type ProjectMartLargeRebuildHeartbeatConfig = {
  automatic: ProjectMartLargeRebuildAutomaticHeartbeatConfig
  batchSize: number
  maxCyclesPerWake: number
  maxWakeMs: number
  pollIntervalMs: number
  sources: ProjectMartLargeRebuildHeartbeatFieldSources
  stored: {
    maintenanceWorkerDuckdbMemoryLimit: string | null
    batchSize: number | null
    maxCyclesPerWake: number | null
    maxWakeMs: number | null
    pollIntervalMs: number | null
    tuningMode: StoredProjectMartLargeRebuildSettings['tuningMode']
  }
}

const gibibyte = 1024 ** 3
const mebibyte = 1024 ** 2
const configCacheTtlMs = 2_000

let cachedConfig: {expiresAt: number; value: ProjectMartLargeRebuildHeartbeatConfig} | null = null

const getPositiveInteger = (value: number | string | null | undefined) => {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value ?? '').trim(), 10)

  return Number.isInteger(parsed) && parsed > 0 ? parsed : null
}

const getResolvedMaintenanceWorkerDuckdbMemoryLimit = ({
  envValues,
  storedSettings,
}: {
  envValues: Record<string, string | undefined>
  storedSettings: StoredProjectMartLargeRebuildSettings
}) => {
  const storedValue = storedSettings.maintenanceWorkerDuckdbMemoryLimit?.trim()

  return storedValue && storedValue.length > 0 ? storedValue : (envValues.DUCKDB_MEMORY_LIMIT ?? null)
}

const getFieldValue = ({
  automaticValue,
  envValue,
  manualValue,
  useManualValue,
}: {
  automaticValue: number
  envValue: number | null
  manualValue: number | null
  useManualValue: boolean
}) => {
  if (envValue !== null) {
    return {source: 'env' as const, value: envValue}
  }

  if (useManualValue && manualValue !== null) {
    return {source: 'manual' as const, value: manualValue}
  }

  return {source: 'automatic' as const, value: automaticValue}
}

const getStoredProjectMartLargeRebuildSettings = async (): Promise<StoredProjectMartLargeRebuildSettings> => {
  try {
    const userConfig = await getUserConfigQueryService().getOrCreateUserConfig()

    return {
      maintenanceWorkerDuckdbMemoryLimit: userConfig.maintenanceWorkerDuckdbMemoryLimit,
      batchSize: userConfig.projectMartLargeRebuildBatchSize,
      maxCyclesPerWake: userConfig.projectMartLargeRebuildMaxCyclesPerWake,
      maxWakeMs: userConfig.projectMartLargeRebuildMaxWakeMs,
      pollIntervalMs: userConfig.projectMartLargeRebuildPollIntervalMs,
      tuningMode: userConfig.projectMartLargeRebuildTuningMode,
    }
  } catch {
    const localAppSettings = readLocalAppSettings()

    return {
      maintenanceWorkerDuckdbMemoryLimit: localAppSettings.maintenanceWorkerDuckdbMemoryLimit,
      batchSize: localAppSettings.projectMartLargeRebuildBatchSize,
      maxCyclesPerWake: localAppSettings.projectMartLargeRebuildMaxCyclesPerWake,
      maxWakeMs: localAppSettings.projectMartLargeRebuildMaxWakeMs,
      pollIntervalMs: localAppSettings.projectMartLargeRebuildPollIntervalMs,
      tuningMode: localAppSettings.projectMartLargeRebuildTuningMode,
    }
  }
}

const getActiveLargeRebuildProjectCount = async () => {
  try {
    const [row] = await getAppDatabaseService().queryJson<{activeLargeRebuildProjectCount: number}>(`
      SELECT CAST(COUNT(*) AS INTEGER) AS activeLargeRebuildProjectCount
      FROM app.project_mart_large_rebuild_state
      WHERE refresh_token > 0
    `)

    return row?.activeLargeRebuildProjectCount ?? 0
  } catch {
    return 0
  }
}

export const getAutomaticProjectMartLargeRebuildHeartbeatConfig = ({
  activeLargeRebuildProjectCount,
  maintenanceWorkerDuckdbMemoryLimit = null,
  totalMemoryBytes = totalmem(),
}: {
  activeLargeRebuildProjectCount: number
  maintenanceWorkerDuckdbMemoryLimit?: string | null
  totalMemoryBytes?: number
}): ProjectMartLargeRebuildAutomaticHeartbeatConfig => {
  const maintenanceWorkerDuckdbMemoryLimitMiB = parseDuckdbMemoryLimitToMiB(maintenanceWorkerDuckdbMemoryLimit)
  const effectiveTotalMemoryBytes =
    maintenanceWorkerDuckdbMemoryLimitMiB === null
      ? totalMemoryBytes
      : Math.min(totalMemoryBytes, maintenanceWorkerDuckdbMemoryLimitMiB * mebibyte)
  const totalMemoryGb = Math.max(1, Math.floor(effectiveTotalMemoryBytes / gibibyte))
  const activeRebuildCount = Math.max(activeLargeRebuildProjectCount, 0)

  if (totalMemoryGb <= 16) {
    return {
      activeLargeRebuildProjectCount: activeRebuildCount,
      batchSize: activeRebuildCount <= 1 ? 512 : activeRebuildCount === 2 ? 256 : 128,
      maxCyclesPerWake: 4,
      maxWakeMs: 2_000,
      pollIntervalMs: 1000,
      profile: 'small',
      totalMemoryGb,
    }
  }

  if (totalMemoryGb <= 32) {
    return {
      activeLargeRebuildProjectCount: activeRebuildCount,
      batchSize: activeRebuildCount <= 1 ? 2048 : activeRebuildCount === 2 ? 1024 : 512,
      maxCyclesPerWake: 8,
      maxWakeMs: 3_000,
      pollIntervalMs: 500,
      profile: 'medium',
      totalMemoryGb,
    }
  }

  return {
    activeLargeRebuildProjectCount: activeRebuildCount,
    batchSize: activeRebuildCount <= 1 ? 4096 : activeRebuildCount === 2 ? 2048 : 1024,
    maxCyclesPerWake: 16,
    maxWakeMs: 5_000,
    pollIntervalMs: 250,
    profile: 'large',
    totalMemoryGb,
  }
}

export const resolveProjectMartLargeRebuildHeartbeatConfig = ({
  activeLargeRebuildProjectCount,
  envValues = process.env,
  storedSettings,
  totalMemoryBytes = totalmem(),
}: {
  activeLargeRebuildProjectCount: number
  envValues?: Record<string, string | undefined>
  storedSettings: StoredProjectMartLargeRebuildSettings
  totalMemoryBytes?: number
}): ProjectMartLargeRebuildHeartbeatConfig => {
  const maintenanceWorkerDuckdbMemoryLimit = getResolvedMaintenanceWorkerDuckdbMemoryLimit({envValues, storedSettings})
  const automatic = getAutomaticProjectMartLargeRebuildHeartbeatConfig({
    activeLargeRebuildProjectCount,
    maintenanceWorkerDuckdbMemoryLimit,
    totalMemoryBytes,
  })
  const useManualValue = storedSettings.tuningMode === 'manual'
  const batchSize = getFieldValue({
    automaticValue: automatic.batchSize,
    envValue: getPositiveInteger(envValues.PROJECT_MART_LARGE_REBUILD_BATCH_SIZE),
    manualValue: storedSettings.batchSize,
    useManualValue,
  })
  const maxCyclesPerWake = getFieldValue({
    automaticValue: automatic.maxCyclesPerWake,
    envValue: getPositiveInteger(envValues.PROJECT_MART_LARGE_REBUILD_MAX_CYCLES_PER_WAKE),
    manualValue: storedSettings.maxCyclesPerWake,
    useManualValue,
  })
  const maxWakeMs = getFieldValue({
    automaticValue: automatic.maxWakeMs,
    envValue: getPositiveInteger(envValues.PROJECT_MART_LARGE_REBUILD_MAX_WAKE_MS),
    manualValue: storedSettings.maxWakeMs,
    useManualValue,
  })
  const pollIntervalMs = getFieldValue({
    automaticValue: automatic.pollIntervalMs,
    envValue: getPositiveInteger(envValues.PROJECT_MART_LARGE_REBUILD_POLL_INTERVAL_MS),
    manualValue: storedSettings.pollIntervalMs,
    useManualValue,
  })

  return {
    automatic,
    batchSize: batchSize.value,
    maxCyclesPerWake: maxCyclesPerWake.value,
    maxWakeMs: maxWakeMs.value,
    pollIntervalMs: pollIntervalMs.value,
    sources: {
      batchSize: batchSize.source,
      maxCyclesPerWake: maxCyclesPerWake.source,
      maxWakeMs: maxWakeMs.source,
      pollIntervalMs: pollIntervalMs.source,
    },
    stored: {
      maintenanceWorkerDuckdbMemoryLimit: storedSettings.maintenanceWorkerDuckdbMemoryLimit,
      batchSize: storedSettings.batchSize,
      maxCyclesPerWake: storedSettings.maxCyclesPerWake,
      maxWakeMs: storedSettings.maxWakeMs,
      pollIntervalMs: storedSettings.pollIntervalMs,
      tuningMode: storedSettings.tuningMode,
    },
  }
}

export const getProjectMartLargeRebuildHeartbeatConfig = async () => {
  const now = Date.now()

  if (cachedConfig !== null && cachedConfig.expiresAt > now) {
    return cachedConfig.value
  }

  const value = resolveProjectMartLargeRebuildHeartbeatConfig({
    activeLargeRebuildProjectCount: await getActiveLargeRebuildProjectCount(),
    storedSettings: await getStoredProjectMartLargeRebuildSettings(),
  })

  cachedConfig = {expiresAt: now + configCacheTtlMs, value}
  return value
}

export const resetProjectMartLargeRebuildTuningForTests = () => {
  cachedConfig = null
}
