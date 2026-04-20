export type RuntimeProfileName = 'primary' | 'secondary'

export type RuntimeProfileEnv = {
  API_SERVER_PORT: string
  APP_SERVER_PORT: string
  BACKGROUND_WRITER_PORT: string
  DUCKDB_PATH: string
  FORSKA_RUNTIME_PROFILE: RuntimeProfileName
  VITE_PORT: string
}

type RuntimeProfile = {dataRoot: string; env: RuntimeProfileEnv; name: RuntimeProfileName}

const runtimeProfileEntries: Record<RuntimeProfileName, RuntimeProfile> = {
  primary: {
    dataRoot: 'data/runtime/primary',
    env: {
      API_SERVER_PORT: '3001',
      APP_SERVER_PORT: '8080',
      BACKGROUND_WRITER_PORT: '3002',
      DUCKDB_PATH: 'data/runtime/primary/forska.duckdb',
      FORSKA_RUNTIME_PROFILE: 'primary',
      VITE_PORT: '3000',
    },
    name: 'primary',
  },
  secondary: {
    dataRoot: 'data/runtime/secondary',
    env: {
      API_SERVER_PORT: '3101',
      APP_SERVER_PORT: '8180',
      BACKGROUND_WRITER_PORT: '3102',
      DUCKDB_PATH: 'data/runtime/secondary/forska.duckdb',
      FORSKA_RUNTIME_PROFILE: 'secondary',
      VITE_PORT: '3100',
    },
    name: 'secondary',
  },
}

export const runtimeProfiles = runtimeProfileEntries

export const getRuntimeProfile = (profileName: RuntimeProfileName): RuntimeProfile => {
  return runtimeProfiles[profileName]
}

export const getRuntimeProfileEnv = (profileName: RuntimeProfileName): RuntimeProfileEnv => {
  return getRuntimeProfile(profileName).env
}

export const mergeRuntimeProfileEnv = ({
  baseEnv = process.env,
  overrides = {},
  profileName,
}: {
  baseEnv?: Record<string, string | undefined>
  overrides?: Record<string, string | undefined>
  profileName: RuntimeProfileName
}) => {
  return {...baseEnv, ...getRuntimeProfileEnv(profileName), ...overrides}
}
