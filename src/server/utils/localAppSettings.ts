import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'fs'
import {dirname, join} from 'path'

import {getConfiguredDuckdbPath, getDuckdbPath} from './getDuckdbPath.ts'

export type ProjectMartLargeRebuildTuningMode = 'automatic' | 'manual'

export type LocalAppSettings = {
  maintenanceWorkerDuckdbMemoryLimit: string | null
  codexBin: string | null
  duckdbBin: string | null
  projectMartLargeRebuildBatchSize: number | null
  projectMartLargeRebuildMaxCyclesPerWake: number | null
  projectMartLargeRebuildPollIntervalMs: number | null
  projectMartLargeRebuildTuningMode: ProjectMartLargeRebuildTuningMode
}

const defaultLocalAppSettings: LocalAppSettings = {
  maintenanceWorkerDuckdbMemoryLimit: null,
  codexBin: null,
  duckdbBin: null,
  projectMartLargeRebuildBatchSize: null,
  projectMartLargeRebuildMaxCyclesPerWake: null,
  projectMartLargeRebuildPollIntervalMs: null,
  projectMartLargeRebuildTuningMode: 'automatic',
}
const legacyMaintenanceWorkerDuckdbMemoryLimitKey = 'backgroundWriterDuckdbMemoryLimit'
type ParsedLocalAppSettings = {settings: LocalAppSettings; shouldRewrite: boolean}

const getNullableTrimmedValue = (value: string | null | undefined): string | null => {
  const normalized = String(value ?? '').trim()

  return normalized === '' ? null : normalized
}

const getNullablePositiveInteger = (value: unknown): number | null => {
  const parsed =
    typeof value === 'number' ? value : typeof value === 'string' ? Number.parseInt(value.trim(), 10) : Number.NaN

  return Number.isInteger(parsed) && parsed > 0 ? parsed : null
}

const getProjectMartLargeRebuildTuningMode = (value: unknown): ProjectMartLargeRebuildTuningMode => {
  return value === 'manual' ? 'manual' : 'automatic'
}

const getLocalAppSettingsDatabasePath = (): string => {
  const configuredPath = getConfiguredDuckdbPath()

  return configuredPath === ':memory:' ? getDuckdbPath() : configuredPath
}

export const getLocalAppSettingsPath = (): string => {
  return join(dirname(getLocalAppSettingsDatabasePath()), 'forska.settings.json')
}

const getLocalAppSettingsRecord = (value: unknown): Record<string, unknown> | null => {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

const getOptionalString = (record: Record<string, unknown> | null, key: string): string | null => {
  const value = record?.[key]

  return typeof value === 'string' ? value : null
}

const getMaintenanceWorkerDuckdbMemoryLimit = (record: Record<string, unknown> | null): string | null => {
  const currentValue = getOptionalString(record, 'maintenanceWorkerDuckdbMemoryLimit')
  const legacyValue = getOptionalString(record, legacyMaintenanceWorkerDuckdbMemoryLimitKey)

  return getNullableTrimmedValue(currentValue === null ? legacyValue : currentValue)
}

const shouldRewriteLocalAppSettings = (record: Record<string, unknown> | null): boolean => {
  return record !== null && legacyMaintenanceWorkerDuckdbMemoryLimitKey in record
}

const writeLocalAppSettings = (filePath: string, settings: LocalAppSettings): void => {
  mkdirSync(dirname(filePath), {recursive: true})
  writeFileSync(filePath, `${JSON.stringify(settings, null, 2)}\n`)
}

const parseLocalAppSettings = (raw: string): ParsedLocalAppSettings => {
  try {
    const parsed = JSON.parse(raw) as unknown
    const record = getLocalAppSettingsRecord(parsed)

    return {
      settings: {
        maintenanceWorkerDuckdbMemoryLimit: getMaintenanceWorkerDuckdbMemoryLimit(record),
        codexBin: getNullableTrimmedValue(getOptionalString(record, 'codexBin')),
        duckdbBin: getNullableTrimmedValue(getOptionalString(record, 'duckdbBin')),
        projectMartLargeRebuildBatchSize: getNullablePositiveInteger(record?.projectMartLargeRebuildBatchSize),
        projectMartLargeRebuildMaxCyclesPerWake: getNullablePositiveInteger(
          record?.projectMartLargeRebuildMaxCyclesPerWake,
        ),
        projectMartLargeRebuildPollIntervalMs: getNullablePositiveInteger(
          record?.projectMartLargeRebuildPollIntervalMs,
        ),
        projectMartLargeRebuildTuningMode: getProjectMartLargeRebuildTuningMode(
          record?.projectMartLargeRebuildTuningMode,
        ),
      },
      shouldRewrite: shouldRewriteLocalAppSettings(record),
    }
  } catch {
    return {settings: defaultLocalAppSettings, shouldRewrite: false}
  }
}

export const readLocalAppSettings = (): LocalAppSettings => {
  const filePath = getLocalAppSettingsPath()

  if (!existsSync(filePath)) {
    return defaultLocalAppSettings
  }

  const parsed = parseLocalAppSettings(readFileSync(filePath, 'utf8'))

  if (parsed.shouldRewrite) {
    writeLocalAppSettings(filePath, parsed.settings)
  }

  return parsed.settings
}

export const updateLocalAppSettings = ({
  maintenanceWorkerDuckdbMemoryLimit,
  codexBin,
  duckdbBin,
  projectMartLargeRebuildBatchSize,
  projectMartLargeRebuildMaxCyclesPerWake,
  projectMartLargeRebuildPollIntervalMs,
  projectMartLargeRebuildTuningMode,
}: {
  maintenanceWorkerDuckdbMemoryLimit: string | null
  codexBin: string | null
  duckdbBin: string | null
  projectMartLargeRebuildBatchSize: number | null
  projectMartLargeRebuildMaxCyclesPerWake: number | null
  projectMartLargeRebuildPollIntervalMs: number | null
  projectMartLargeRebuildTuningMode: ProjectMartLargeRebuildTuningMode
}): LocalAppSettings => {
  const filePath = getLocalAppSettingsPath()
  const nextValue = {
    maintenanceWorkerDuckdbMemoryLimit: getNullableTrimmedValue(maintenanceWorkerDuckdbMemoryLimit),
    codexBin: getNullableTrimmedValue(codexBin),
    duckdbBin: getNullableTrimmedValue(duckdbBin),
    projectMartLargeRebuildBatchSize: getNullablePositiveInteger(projectMartLargeRebuildBatchSize),
    projectMartLargeRebuildMaxCyclesPerWake: getNullablePositiveInteger(projectMartLargeRebuildMaxCyclesPerWake),
    projectMartLargeRebuildPollIntervalMs: getNullablePositiveInteger(projectMartLargeRebuildPollIntervalMs),
    projectMartLargeRebuildTuningMode: getProjectMartLargeRebuildTuningMode(projectMartLargeRebuildTuningMode),
  } satisfies LocalAppSettings

  writeLocalAppSettings(filePath, nextValue)

  return nextValue
}
