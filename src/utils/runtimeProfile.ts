export type RuntimeProfileName = 'primary' | 'secondary'

export type RuntimeProfileEnv = {
  API_SERVER_PORT: string
  APP_SERVER_PORT: string
  BACKGROUND_JUDGE_PORT: string
  BACKGROUND_MAINTENANCE_PORT: string
  DUCKDB_PATH: string
  FORSKA_RUNTIME_PROFILE: RuntimeProfileName
  JUDGE_WORKER_ID: string
  VITE_PORT: string
}

type RuntimeProfile = {dataRoot: string; env: RuntimeProfileEnv; name: RuntimeProfileName}
type RuntimeProfilePathOptions = {envValues?: Record<string, string | undefined>; platform?: string}
type RuntimeProfileConfig = Omit<RuntimeProfileEnv, 'DUCKDB_PATH' | 'FORSKA_RUNTIME_PROFILE' | 'JUDGE_WORKER_ID'>

const runtimeProfileConfig: Record<RuntimeProfileName, RuntimeProfileConfig> = {
  primary: {
    API_SERVER_PORT: '3001',
    APP_SERVER_PORT: '8080',
    BACKGROUND_JUDGE_PORT: '3003',
    BACKGROUND_MAINTENANCE_PORT: '3002',
    VITE_PORT: '3000',
  },
  secondary: {
    API_SERVER_PORT: '3101',
    APP_SERVER_PORT: '8180',
    BACKGROUND_JUDGE_PORT: '3103',
    BACKGROUND_MAINTENANCE_PORT: '3102',
    VITE_PORT: '3100',
  },
}

const getCurrentEnvValues = () => {
  return typeof process === 'undefined' ? {} : process.env
}

const getCurrentPlatform = () => {
  return typeof process === 'undefined' ? 'linux' : process.platform
}

const getTrimmedValue = (value: string | null | undefined) => {
  const normalized = String(value ?? '').trim()

  return normalized === '' ? null : normalized
}

const trimTrailingPathSeparators = (value: string) => {
  return value.replace(/[\\/]+$/, '')
}

const expandHomeDirectory = (pathValue: string, homeDir: string | null, separator: string) => {
  if (homeDir === null) {
    return pathValue
  }

  if (pathValue === '~') {
    return trimTrailingPathSeparators(homeDir)
  }

  return pathValue.startsWith('~/') || pathValue.startsWith('~\\')
    ? `${trimTrailingPathSeparators(homeDir)}${separator}${pathValue.slice(2)}`
    : pathValue
}

const getHomeDirectory = (envValues: Record<string, string | undefined>) => {
  return getTrimmedValue(envValues.HOME) ?? getTrimmedValue(envValues.USERPROFILE)
}

const getWindowsDataRoot = (envValues: Record<string, string | undefined>) => {
  const localAppData = getTrimmedValue(envValues.LOCALAPPDATA)
  const userProfile = getTrimmedValue(envValues.USERPROFILE)

  return localAppData ?? (userProfile === null ? null : `${trimTrailingPathSeparators(userProfile)}\\AppData\\Local`)
}

const getLinuxDataRoot = (envValues: Record<string, string | undefined>) => {
  const homeDir = getHomeDirectory(envValues)
  const xdgDataHome = getTrimmedValue(envValues.XDG_DATA_HOME)

  return xdgDataHome !== null
    ? expandHomeDirectory(xdgDataHome, homeDir, '/')
    : homeDir === null
      ? null
      : `${trimTrailingPathSeparators(homeDir)}/.local/share`
}

const getFallbackRuntimeProfileDataRoot = (profileName: RuntimeProfileName, separator: string) => {
  return ['data', 'runtime', profileName].join(separator)
}

export const getLegacyRuntimeProfileDuckdbPath = (profileName: RuntimeProfileName) => {
  return `data/runtime/${profileName}/forska.duckdb`
}

export const getRuntimeProfileDataRoot = ({
  envValues = getCurrentEnvValues(),
  platform = getCurrentPlatform(),
  profileName,
}: RuntimeProfilePathOptions & {profileName: RuntimeProfileName}) => {
  if (platform === 'win32') {
    const windowsDataRoot = getWindowsDataRoot(envValues)

    return windowsDataRoot === null
      ? getFallbackRuntimeProfileDataRoot(profileName, '\\')
      : `${trimTrailingPathSeparators(windowsDataRoot)}\\Forska\\runtime\\${profileName}`
  }

  if (platform === 'darwin') {
    const homeDir = getHomeDirectory(envValues)

    return homeDir === null
      ? getFallbackRuntimeProfileDataRoot(profileName, '/')
      : `${trimTrailingPathSeparators(homeDir)}/Library/Application Support/Forska/runtime/${profileName}`
  }

  const linuxDataRoot = getLinuxDataRoot(envValues)

  return linuxDataRoot === null
    ? getFallbackRuntimeProfileDataRoot(profileName, '/')
    : `${trimTrailingPathSeparators(linuxDataRoot)}/forska/runtime/${profileName}`
}

export const getRuntimeProfileDuckdbPath = (options: RuntimeProfilePathOptions & {profileName: RuntimeProfileName}) => {
  const separator = (options.platform ?? getCurrentPlatform()) === 'win32' ? '\\' : '/'

  return `${getRuntimeProfileDataRoot(options)}${separator}forska.duckdb`
}

export const getRuntimeProfile = (
  profileName: RuntimeProfileName,
  options: RuntimeProfilePathOptions = {},
): RuntimeProfile => {
  const config = runtimeProfileConfig[profileName]

  return {
    dataRoot: getRuntimeProfileDataRoot({...options, profileName}),
    env: {
      ...config,
      DUCKDB_PATH: getRuntimeProfileDuckdbPath({...options, profileName}),
      FORSKA_RUNTIME_PROFILE: profileName,
      JUDGE_WORKER_ID: `${profileName}-judge-worker`,
    },
    name: profileName,
  }
}

export const runtimeProfiles: Record<RuntimeProfileName, RuntimeProfile> = {
  primary: getRuntimeProfile('primary'),
  secondary: getRuntimeProfile('secondary'),
}

export const getRuntimeProfileEnv = (
  profileName: RuntimeProfileName,
  options: RuntimeProfilePathOptions = {},
): RuntimeProfileEnv => {
  return getRuntimeProfile(profileName, options).env
}

export const mergeRuntimeProfileEnv = ({
  baseEnv = getCurrentEnvValues(),
  overrides = {},
  profileName,
}: {
  baseEnv?: Record<string, string | undefined>
  overrides?: Record<string, string | undefined>
  profileName: RuntimeProfileName
}) => {
  return {
    ...baseEnv,
    ...getRuntimeProfileEnv(profileName, {envValues: {...getCurrentEnvValues(), ...baseEnv}}),
    ...overrides,
  }
}
