import {dirname, isAbsolute, normalize, resolve} from 'node:path'

import {getConfiguredDuckdbPath} from './getDuckdbPath.ts'

type RuntimePathOptions = {cwd?: string; envValues?: Record<string, string | undefined>}

const getTrimmedValue = (value: string | null | undefined) => {
  const normalizedValue = String(value ?? '').trim()

  return normalizedValue === '' ? null : normalizedValue
}

const isDesktopRuntime = (envValues: Record<string, string | undefined>) => {
  return getTrimmedValue(envValues.FORSKA_DESKTOP_MODE)?.toLowerCase() === 'true'
}

export const getRuntimeWritableRoot = ({cwd = process.cwd(), envValues = process.env}: RuntimePathOptions = {}) => {
  if (!isDesktopRuntime(envValues)) {
    return cwd
  }

  const duckdbPath = getConfiguredDuckdbPath({cwd, envValues})

  return duckdbPath === ':memory:' ? cwd : dirname(duckdbPath)
}

export const resolveRuntimeWritablePath = ({
  cwd = process.cwd(),
  envValues = process.env,
  pathValue,
}: RuntimePathOptions & {pathValue: string}) => {
  return resolve(getRuntimeWritableRoot({cwd, envValues}), pathValue)
}

export const resolveRuntimeFilePath = ({
  cwd = process.cwd(),
  envValues = process.env,
  pathValue,
}: RuntimePathOptions & {pathValue: string}) => {
  return isAbsolute(pathValue) ? normalize(pathValue) : resolveRuntimeWritablePath({cwd, envValues, pathValue})
}
