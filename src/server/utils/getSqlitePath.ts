import {mkdirSync} from 'fs'
import {homedir} from 'os'
import {posix, win32} from 'path'

type Platform = typeof process.platform
type PathModule = typeof posix

type SqlitePathOptions = {
  cwd?: string
  envValues?: Record<string, string | undefined>
  homeDir?: string
  platform?: Platform
  sqlitePath?: string | null | undefined
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

const getDefaultSqlitePath = (
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
  return pathModule.join(appDataRoot, 'forska.sqlite')
}

const getResolvedSqlitePath = (
  pathModule: PathModule,
  cwd: string,
  defaultSqlitePath: string,
  homeDir: string,
  sqlitePath?: string | null,
) => {
  const configuredPath = getTrimmedValue(sqlitePath)
  const selectedPath = configuredPath == null ? defaultSqlitePath : expandHomeDirectory(configuredPath, homeDir)

  if (selectedPath === ':memory:') {
    return selectedPath
  }

  return pathModule.isAbsolute(selectedPath)
    ? pathModule.normalize(selectedPath)
    : pathModule.resolve(cwd, selectedPath)
}

export const getSqlitePath = ({
  cwd = process.cwd(),
  envValues = process.env,
  homeDir = homedir(),
  platform = process.platform,
  sqlitePath,
}: SqlitePathOptions = {}) => {
  const pathModule = getPathModule(platform)
  const defaultSqlitePath = getDefaultSqlitePath(pathModule, platform, homeDir, envValues)
  return getResolvedSqlitePath(pathModule, cwd, defaultSqlitePath, homeDir, sqlitePath)
}

export const ensureSqlitePathDirectory = (sqlitePath: string) => {
  if (sqlitePath === ':memory:') {
    return sqlitePath
  }

  mkdirSync(getPathModule(process.platform).dirname(sqlitePath), {recursive: true})
  return sqlitePath
}
