import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'fs'
import {dirname, join} from 'path'

import {getConfiguredDuckdbPath, getDuckdbPath} from './getDuckdbPath.ts'

export type LocalAppSettings = {codexBin: string | null; duckdbBin: string | null}

const defaultLocalAppSettings: LocalAppSettings = {codexBin: null, duckdbBin: null}

const getNullableTrimmedValue = (value: string | null | undefined): string | null => {
  const normalized = String(value ?? '').trim()

  return normalized === '' ? null : normalized
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
      codexBin: getNullableTrimmedValue(typeof record?.codexBin === 'string' ? record.codexBin : null),
      duckdbBin: getNullableTrimmedValue(typeof record?.duckdbBin === 'string' ? record.duckdbBin : null),
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
  codexBin,
  duckdbBin,
}: {
  codexBin: string | null
  duckdbBin: string | null
}): LocalAppSettings => {
  const filePath = getLocalAppSettingsPath()
  const nextValue = {codexBin: getNullableTrimmedValue(codexBin), duckdbBin: getNullableTrimmedValue(duckdbBin)}

  mkdirSync(dirname(filePath), {recursive: true})
  writeFileSync(filePath, `${JSON.stringify(nextValue, null, 2)}\n`)

  return nextValue
}
