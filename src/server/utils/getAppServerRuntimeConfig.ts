import {type as arktype} from 'arktype'

const appServerRuntimeShape = arktype({
  APP_SERVER_API_HOST: 'string',
  APP_SERVER_API_PORT: 'number | string.integer.parse',
  APP_SERVER_API_SCHEME: 'string',
  APP_SERVER_DIST_DIR: 'string',
  APP_SERVER_PORT: 'number | string.integer.parse',
})

const getTrimmedValue = (value: string | null | undefined): string | null => {
  const normalized = String(value ?? '').trim()

  return normalized === '' ? null : normalized
}

const getFirstConfiguredValue = ({
  envValues,
  fallback,
  keys,
}: {
  envValues: Record<string, string | undefined>
  fallback: string
  keys: string[]
}): string => {
  const configuredValue = keys.reduce<string | null>((resolved, key) => {
    return resolved ?? getTrimmedValue(envValues[key])
  }, null)

  return configuredValue ?? fallback
}

export const getAppServerRuntimeConfig = ({
  envValues = process.env,
}: {envValues?: Record<string, string | undefined>} = {}) => {
  const parsed = appServerRuntimeShape.assert({
    APP_SERVER_API_HOST: getFirstConfiguredValue({
      envValues,
      fallback: 'localhost',
      keys: ['APP_SERVER_API_HOST', 'SERVER_HOST', 'API_HOST'],
    }),
    APP_SERVER_API_PORT: getFirstConfiguredValue({
      envValues,
      fallback: '3000',
      keys: ['APP_SERVER_API_PORT', 'API_SERVER_PORT'],
    }),
    APP_SERVER_API_SCHEME: getFirstConfiguredValue({
      envValues,
      fallback: 'http',
      keys: ['APP_SERVER_API_SCHEME', 'SERVER_SCHEME'],
    }),
    APP_SERVER_DIST_DIR: getFirstConfiguredValue({
      envValues,
      fallback: '',
      keys: ['APP_SERVER_DIST_DIR', 'APP_DIST_DIR', 'DIST_DIR', 'PUBLIC_DIR'],
    }),
    APP_SERVER_PORT: getFirstConfiguredValue({envValues, fallback: '8080', keys: ['APP_SERVER_PORT', 'PROD_SERVER']}),
  })

  return {
    apiHost: parsed.APP_SERVER_API_HOST,
    apiPort: parsed.APP_SERVER_API_PORT,
    apiScheme: parsed.APP_SERVER_API_SCHEME,
    distDir: getTrimmedValue(parsed.APP_SERVER_DIST_DIR),
    port: parsed.APP_SERVER_PORT,
  }
}
