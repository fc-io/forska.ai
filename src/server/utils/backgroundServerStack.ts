import {DEFAULT_API_SERVER_PORT} from '../../utils/runtimePortDefaults.ts'

type BackgroundServerRole = 'api' | 'worker'

type BackgroundServerStackConfig = {apiPort: number; workerPort: number; writerUrl: string}

const getIntegerPort = (value: string | undefined, fallback: number) => {
  const parsed = Number.parseInt(String(value ?? '').trim(), 10)

  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback
}

export const getBackgroundServerStackConfig = (
  envValues: Record<string, string | undefined> = process.env,
): BackgroundServerStackConfig => {
  const apiPort = getIntegerPort(envValues.API_SERVER_PORT, DEFAULT_API_SERVER_PORT)
  const workerPort = getIntegerPort(envValues.BACKGROUND_WRITER_PORT, apiPort + 1)

  return {apiPort, workerPort, writerUrl: `http://127.0.0.1:${workerPort}`}
}

export const getBackgroundServerEnv = ({
  baseEnv,
  role,
}: {
  baseEnv?: Record<string, string | undefined>
  role: BackgroundServerRole
}) => {
  const resolvedBaseEnv = {...baseEnv, BUN_CONFIG_MAX_HTTP_REQUESTS: baseEnv?.BUN_CONFIG_MAX_HTTP_REQUESTS ?? '2048'}
  const config = getBackgroundServerStackConfig(resolvedBaseEnv)

  return role === 'api'
    ? {
        ...resolvedBaseEnv,
        API_SERVER_PORT: String(config.apiPort),
        SERVER_ROLE: 'api',
        SERVER_WRITER_URL: config.writerUrl,
      }
    : {...resolvedBaseEnv, API_SERVER_PORT: String(config.workerPort), SERVER_ROLE: 'worker', SERVER_WRITER_URL: ''}
}
