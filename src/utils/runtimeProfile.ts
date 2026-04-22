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

const runtimeProfileEntries: Record<RuntimeProfileName, RuntimeProfile> = {
  primary: {
    dataRoot: 'data/runtime/primary',
    env: {
      API_SERVER_PORT: '3001',
      APP_SERVER_PORT: '8080',
      BACKGROUND_JUDGE_PORT: '3003',
      BACKGROUND_MAINTENANCE_PORT: '3002',
      DUCKDB_PATH: 'data/runtime/primary/forska.duckdb',
      FORSKA_RUNTIME_PROFILE: 'primary',
      JUDGE_WORKER_ID: 'primary-judge-worker',
      VITE_PORT: '3000',
    },
    name: 'primary',
  },
  secondary: {
    dataRoot: 'data/runtime/secondary',
    env: {
      API_SERVER_PORT: '3101',
      APP_SERVER_PORT: '8180',
      BACKGROUND_JUDGE_PORT: '3103',
      BACKGROUND_MAINTENANCE_PORT: '3102',
      DUCKDB_PATH: 'data/runtime/secondary/forska.duckdb',
      FORSKA_RUNTIME_PROFILE: 'secondary',
      JUDGE_WORKER_ID: 'secondary-judge-worker',
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
