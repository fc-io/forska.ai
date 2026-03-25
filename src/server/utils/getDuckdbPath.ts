import {mkdirSync} from 'fs'
import {homedir} from 'os'
import {posix, win32} from 'path'

type Platform = typeof process.platform
type PathModule = typeof posix

type DuckdbPathOptions = {
  cwd?: string
  duckdbPath?: string | null | undefined
  envValues?: Record<string, string | undefined>
  homeDir?: string
  platform?: Platform
}

const getPathModule = (platform: Platform) => {
  return platform === 'win32' ? win32 : posix
}

const getTrimmedValue = (value: string | null | undefined) => {
  const normalized = String(value ?? '').trim()
  return normalized === '' ? null : normalized
}

const expandHomeDirectory = (pathValue: string, homeDir: string) => {
  return pathValue === '~' || pathValue.startsWith('~/') || pathValue.startsWith('~\\')
    ? `${homeDir}${pathValue.slice(1)}`
    : pathValue
}

const getAbsoluteRootPath = (pathModule: PathModule, homeDir: string, pathValue: string) => {
  return pathModule.isAbsolute(pathValue) ? pathModule.normalize(pathValue) : pathModule.resolve(homeDir, pathValue)
}

const getLinuxDataRoot = (pathModule: PathModule, homeDir: string, envValues: Record<string, string | undefined>) => {
  const configured = getTrimmedValue(envValues['XDG_DATA_HOME'])
  const rawRoot = configured ? expandHomeDirectory(configured, homeDir) : pathModule.join(homeDir, '.local', 'share')
  return getAbsoluteRootPath(pathModule, homeDir, rawRoot)
}

const getDefaultDuckdbPath = (
  pathModule: PathModule,
  platform: Platform,
  homeDir: string,
  envValues: Record<string, string | undefined>,
) => {
  const windowsLocalAppData = getTrimmedValue(envValues['LOCALAPPDATA'])
  const windowsDataRoot = getAbsoluteRootPath(
    pathModule,
    homeDir,
    expandHomeDirectory(windowsLocalAppData ?? pathModule.join(homeDir, 'AppData', 'Local'), homeDir),
  )
  const appDataRoot =
    platform === 'darwin'
      ? pathModule.join(homeDir, 'Library', 'Application Support', 'Forska')
      : platform === 'win32'
        ? pathModule.join(windowsDataRoot, 'Forska')
        : pathModule.join(getLinuxDataRoot(pathModule, homeDir, envValues), 'forska')
  return pathModule.join(appDataRoot, 'forska.duckdb')
}

const getResolvedDuckdbPath = (
  pathModule: PathModule,
  cwd: string,
  defaultDuckdbPath: string,
  homeDir: string,
  duckdbPath?: string | null,
) => {
  const configuredPath = getTrimmedValue(duckdbPath)
  const selectedPath = configuredPath == null ? defaultDuckdbPath : expandHomeDirectory(configuredPath, homeDir)

  if (selectedPath === ':memory:') {
    return selectedPath
  }

  return pathModule.isAbsolute(selectedPath)
    ? pathModule.normalize(selectedPath)
    : pathModule.resolve(cwd, selectedPath)
}

export const getDuckdbPath = ({
  cwd = process.cwd(),
  duckdbPath,
  envValues = process.env,
  homeDir = homedir(),
  platform = process.platform,
}: DuckdbPathOptions = {}) => {
  const pathModule = getPathModule(platform)
  const defaultDuckdbPath = getDefaultDuckdbPath(pathModule, platform, homeDir, envValues)
  return getResolvedDuckdbPath(pathModule, cwd, defaultDuckdbPath, homeDir, duckdbPath)
}

export const getConfiguredDuckdbPath = ({
  cwd,
  envValues = process.env,
  homeDir,
  platform,
}: Omit<DuckdbPathOptions, 'duckdbPath'> = {}) => {
  return getDuckdbPath({cwd, duckdbPath: envValues.DUCKDB_PATH, envValues, homeDir, platform})
}

export const ensureDuckdbPathDirectory = (duckdbPath: string) => {
  if (duckdbPath === ':memory:') {
    return duckdbPath
  }

  mkdirSync(getPathModule(process.platform).dirname(duckdbPath), {recursive: true})
  return duckdbPath
}
