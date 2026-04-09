import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'fs'
import {dirname, join} from 'path'

import {getConfiguredDuckdbPath, getDuckdbPath} from './getDuckdbPath.ts'

export type ProjectMartLargeRebuildTuningMode = 'automatic' | 'manual'

export type LocalAppSettings = {
  backgroundWriterDuckdbMemoryLimit: string | null
  codexBin: string | null
  duckdbBin: string | null
  projectMartLargeRebuildBatchSize: number | null
  projectMartLargeRebuildMaxCyclesPerWake: number | null
  projectMartLargeRebuildPollIntervalMs: number | null
  projectMartLargeRebuildTuningMode: ProjectMartLargeRebuildTuningMode
}

const defaultLocalAppSettings: LocalAppSettings = {
  backgroundWriterDuckdbMemoryLimit: null,
  codexBin: null,
  duckdbBin: null,
  projectMartLargeRebuildBatchSize: null,
  projectMartLargeRebuildMaxCyclesPerWake: null,
  projectMartLargeRebuildPollIntervalMs: null,
  projectMartLargeRebuildTuningMode: 'automatic',
}

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

const parseLocalAppSettings = (raw: string): LocalAppSettings => {
  try {
    const parsed = JSON.parse(raw) as unknown
    const record = getLocalAppSettingsRecord(parsed)

    return {
      backgroundWriterDuckdbMemoryLimit: getNullableTrimmedValue(
        typeof record?.backgroundWriterDuckdbMemoryLimit === 'string' ? record.backgroundWriterDuckdbMemoryLimit : null,
      ),
      codexBin: getNullableTrimmedValue(typeof record?.codexBin === 'string' ? record.codexBin : null),
      duckdbBin: getNullableTrimmedValue(typeof record?.duckdbBin === 'string' ? record.duckdbBin : null),
      projectMartLargeRebuildBatchSize: getNullablePositiveInteger(record?.projectMartLargeRebuildBatchSize),
      projectMartLargeRebuildMaxCyclesPerWake: getNullablePositiveInteger(
        record?.projectMartLargeRebuildMaxCyclesPerWake,
      ),
      projectMartLargeRebuildPollIntervalMs: getNullablePositiveInteger(record?.projectMartLargeRebuildPollIntervalMs),
      projectMartLargeRebuildTuningMode: getProjectMartLargeRebuildTuningMode(
        record?.projectMartLargeRebuildTuningMode,
      ),
    }
  } catch {
    return defaultLocalAppSettings
  }
}

export const readLocalAppSettings = (): LocalAppSettings => {
  const filePath = getLocalAppSettingsPath()

  return existsSync(filePath) ? parseLocalAppSettings(readFileSync(filePath, 'utf8')) : defaultLocalAppSettings
}

export const updateLocalAppSettings = ({
  backgroundWriterDuckdbMemoryLimit,
  codexBin,
  duckdbBin,
  projectMartLargeRebuildBatchSize,
  projectMartLargeRebuildMaxCyclesPerWake,
  projectMartLargeRebuildPollIntervalMs,
  projectMartLargeRebuildTuningMode,
}: {
  backgroundWriterDuckdbMemoryLimit: string | null
  codexBin: string | null
  duckdbBin: string | null
  projectMartLargeRebuildBatchSize: number | null
  projectMartLargeRebuildMaxCyclesPerWake: number | null
  projectMartLargeRebuildPollIntervalMs: number | null
  projectMartLargeRebuildTuningMode: ProjectMartLargeRebuildTuningMode
}): LocalAppSettings => {
  const filePath = getLocalAppSettingsPath()
  const nextValue = {
    backgroundWriterDuckdbMemoryLimit: getNullableTrimmedValue(backgroundWriterDuckdbMemoryLimit),
    codexBin: getNullableTrimmedValue(codexBin),
    duckdbBin: getNullableTrimmedValue(duckdbBin),
    projectMartLargeRebuildBatchSize: getNullablePositiveInteger(projectMartLargeRebuildBatchSize),
    projectMartLargeRebuildMaxCyclesPerWake: getNullablePositiveInteger(projectMartLargeRebuildMaxCyclesPerWake),
    projectMartLargeRebuildPollIntervalMs: getNullablePositiveInteger(projectMartLargeRebuildPollIntervalMs),
    projectMartLargeRebuildTuningMode: getProjectMartLargeRebuildTuningMode(projectMartLargeRebuildTuningMode),
  } satisfies LocalAppSettings

  mkdirSync(dirname(filePath), {recursive: true})
  writeFileSync(filePath, `${JSON.stringify(nextValue, null, 2)}\n`)

  return nextValue
}
