import {type as arktype} from 'arktype'
import {readFileSync} from 'fs'

const envShape = arktype({
  DATABASE_URL: 'string',
  BETTER_AUTH_SECRET: 'string',
  BETTER_AUTH_URL: 'string',
  VITE_PORT: 'string.integer.parse',
  API_SERVER_PORT: 'string.integer.parse',
  RUN_SERVER_FULL_TEST_FETCHING: arktype('"true" | "false" | boolean').pipe((v) => {
    return typeof v === 'string' ? v.toLowerCase() === 'true' : v
  }),
  RUN_SERVER_JUDGING: arktype('"true" | "false" | boolean').pipe((v) => {
    return typeof v === 'string' ? v.toLowerCase() === 'true' : v
  }),
  // GPU/cluster topology injected by sbatch; numeric fields parse to integers
  GPU_NNODES: 'string.integer.parse',
  GPU_GPUS_PER_NODE: 'string.integer.parse',
  GPU_TOTAL_GPUS: 'string.integer.parse',
  TP_SIZE: 'string.integer.parse',
  DP_SIZE: 'string.integer.parse',
})

const readFromFileVar = (key: string): string | undefined => {
  const fileVar = `${key}_FILE`
  const filePath = process.env[fileVar]
  return filePath ? readFileSync(filePath, 'utf8').trim() : undefined
}

const getEnvWithFileFallback = (): Record<string, string | undefined> => {
  const source = {...process.env}
  const withFile = (k: string): void => {
    if (!source[k]) {
      const v = readFromFileVar(k)
      if (v) source[k] = v
    }
  }
  withFile('DATABASE_URL')
  withFile('BETTER_AUTH_SECRET')
  withFile('BETTER_AUTH_URL')
  return source
}

const loadEnv = (): typeof envShape.infer => {
  const merged = getEnvWithFileFallback()
  // Default to true when not provided
  if (merged.RUN_SERVER_JUDGING == null || merged.RUN_SERVER_JUDGING === '') {
    // string form to satisfy shape before parsing to boolean via pipe
    ;(merged as Record<string, string>).RUN_SERVER_JUDGING = 'true'
  }
  // Default to false when not provided (prevents accidental background fetching)
  if (merged.RUN_SERVER_FULL_TEST_FETCHING == null || merged.RUN_SERVER_FULL_TEST_FETCHING === '') {
    ;(merged as Record<string, string>).RUN_SERVER_FULL_TEST_FETCHING = 'false'
  }
  // Ensure numeric GPU/env defaults exist to satisfy shape; use 0 when not provided
  const numericKeys = ['GPU_NNODES', 'GPU_GPUS_PER_NODE', 'GPU_TOTAL_GPUS', 'TP_SIZE', 'DP_SIZE']
  numericKeys.forEach((k) => {
    if (merged[k] == null || (merged as Record<string, string>)[k] === '') {
      ;(merged as Record<string, string>)[k] = '0'
    }
  })
  return envShape.assert(merged)
}

export const env = loadEnv()
