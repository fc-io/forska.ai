import {type as arktype} from 'arktype'
import {existsSync, readFileSync} from 'fs'

// const parseDbHostPort = (url: string | undefined): {host: string; port: string} | null => {
//   const raw = String(url ?? '').trim()
//   if (!raw) return null
//   const afterScheme = raw.includes('://') ? raw.split('://')[1] : raw
//   const afterAt = afterScheme.includes('@') ? afterScheme.split('@')[1] : afterScheme
//   const hostPortPart = afterAt.split(/[/?]/)[0] || ''
//   if (!hostPortPart) return {host: '<empty>', port: '<none>'}
//   if (hostPortPart.startsWith('[')) {
//     // IPv6 like [::1]:5432 — keep as-is; best-effort port parse
//     const idx = hostPortPart.lastIndexOf(']:')
//     if (idx > -1) return {host: hostPortPart.slice(0, idx + 1), port: hostPortPart.slice(idx + 2) || '<none>'}
//     return {host: hostPortPart, port: '<none>'}
//   }
//   const i = hostPortPart.lastIndexOf(':')
//   if (i > -1) return {host: hostPortPart.slice(0, i), port: hostPortPart.slice(i + 1) || '<none>'}
//   return {host: hostPortPart, port: '<none>'}
// }

const CsvStringArray = arktype('string | null | undefined').pipe((value): string[] => {
  if (value == null) return []
  const normalized = String(value).trim()
  if (normalized === '' || normalized.toLowerCase() === 'null' || normalized.toLowerCase() === 'undefined') {
    return []
  }
  return normalized
    .split(',')
    .map((part) => {
      return part.trim()
    })
    .filter((part) => {
      return part.length > 0
    })
})

const envShape = arktype({
  DATABASE_URL: 'string',
  BETTER_AUTH_SECRET: 'string',
  BETTER_AUTH_URL: 'string | null | undefined',
  OPENALEX_MAILTO: 'string',
  OLAP_DB: '"clickhouse" | "duckdb" | null | undefined',
  VITE_PORT: 'number | string.integer.parse',
  API_SERVER_PORT: 'number | string.integer.parse',
  RUN_SERVER_FULL_TEXT_FETCHING: arktype('"true" | "false" | boolean').pipe((v) => {
    return typeof v === 'string' ? v.toLowerCase() === 'true' : v
  }),
  RUN_SERVER_JUDGING: arktype('"true" | "false" | boolean').pipe((v) => {
    return typeof v === 'string' ? v.toLowerCase() === 'true' : v
  }),
  RUN_SERVER_FULL_TEXT_CONVERSION_CRON: arktype('"true" | "false" | boolean').pipe((v) => {
    return typeof v === 'string' ? v.toLowerCase() === 'true' : v
  }),
  GPU_NNODES: 'number | string.integer.parse',
  GPU_GPUS_PER_NODE: 'number | string.integer.parse',
  GPU_TOTAL_GPUS: 'number | string.integer.parse',
  TP_SIZE: 'number | string.integer.parse',
  PP_SIZE: 'number | string.integer.parse',
  DP_SIZE: 'number | string.integer.parse',
  GPU_SHAPE: 'string | null | undefined',
  // Per SGLang worker/engine
  SGLANG_MAX_RUNNING_REQUESTS: 'number | string.integer.parse',
  // Per worker; 0 => use SGLANG_MAX_RUNNING_REQUESTS
  SGLANG_API_MAX_INFLIGHT_REQUESTS: 'number | string.integer.parse',
  // Per worker; 0 => use SGLANG_MAX_RUNNING_REQUESTS
  SGLANG_API_MAX_BURST_REQUESTS: 'number | string.integer.parse',
  // Judgments cron policy (not SGLang server config)
  JUDGMENTS_READY_TARGET_MULTIPLIER: 'number | string.integer.parse',
  JUDGMENTS_ADD_TO_QUEUE_MAX_BATCH_SIZE: 'number | string.integer.parse',
  SGLANG_MODEL: 'string | null | undefined',
  SGLANG_CONTEXT_LENGTH: 'number | string.integer.parse',
  CODEX_CONTEXT_LENGTH: 'number | string.integer.parse',
  WORKER_URLS: CsvStringArray,
  DOCLING_SERVE_URL: 'string | null | undefined',
  FULL_TEXT_CONVERSION_BATCH_SIZE: 'number | string.integer.parse | null | undefined',
  FULL_TEXT_CONVERSION_CONCURRENCY: 'number | string.integer.parse | null | undefined',
})

const readFromFileVar = (key: string): string | undefined => {
  const fileVar = `${key}_FILE`
  const filePath = process.env[fileVar]
  return filePath && existsSync(filePath) ? readFileSync(filePath, 'utf8').trim() : undefined
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
  // const dbUrlRaw = merged.DATABASE_URL
  // const fileVar = process.env.DATABASE_URL_FILE
  // const fileExists = fileVar ? existsSync(fileVar) : false
  // const isEmpty = (v: unknown): boolean => {
  //   const s = String(v ?? '').trim()
  //   return s.length === 0
  // }
  // if (dbUrlRaw == null || isEmpty(dbUrlRaw)) {
  //   const fileInfo = fileVar ? `${fileVar} (exists: ${fileExists ? 'yes' : 'no'})` : 'unset'
  //   const envInfo = process.env.DATABASE_URL ? 'set (empty/whitespace)' : 'unset'
  //   console.error(`[env] DATABASE_URL missing; DATABASE_URL=${envInfo}; DATABASE_URL_FILE=${fileInfo}`)
  // } else {
  //   const via = fileVar ? (fileExists ? `file:${fileVar}` : 'file:missing') : 'env'
  //   const hp = parseDbHostPort(dbUrlRaw)
  //   if (hp) console.log(`[env] DATABASE_URL host=${hp.host} port=${hp.port} via=${via}`)
  //   console.log(`[env] DATABASE_URL raw=${dbUrlRaw}`)
  // }
  // Default to true when not provided
  if (merged.RUN_SERVER_JUDGING == null || merged.RUN_SERVER_JUDGING === '') {
    // string form to satisfy shape before parsing to boolean via pipe
    ;(merged as Record<string, string>).RUN_SERVER_JUDGING = 'true'
  }
  if (merged.OLAP_DB == null || String(merged.OLAP_DB).trim() === '') {
    ;(merged as Record<string, string>).OLAP_DB = 'clickhouse'
  }
  // Default to false when not provided (prevents accidental background fetching)
  if (merged.RUN_SERVER_FULL_TEXT_FETCHING == null || merged.RUN_SERVER_FULL_TEXT_FETCHING === '') {
    ;(merged as Record<string, string>).RUN_SERVER_FULL_TEXT_FETCHING = 'false'
  }
  // Default to false when not provided (prevents accidental background conversion)
  if (merged.RUN_SERVER_FULL_TEXT_CONVERSION_CRON == null || merged.RUN_SERVER_FULL_TEXT_CONVERSION_CRON === '') {
    ;(merged as Record<string, string>).RUN_SERVER_FULL_TEXT_CONVERSION_CRON = 'false'
  }
  // Ensure numeric GPU/env defaults exist to satisfy shape; use 0 when not provided
  const numericKeys = [
    'GPU_NNODES',
    'GPU_GPUS_PER_NODE',
    'GPU_TOTAL_GPUS',
    'TP_SIZE',
    'PP_SIZE',
    'DP_SIZE',
    'SGLANG_API_MAX_INFLIGHT_REQUESTS',
    'SGLANG_API_MAX_BURST_REQUESTS',
  ]
  numericKeys.forEach((k) => {
    if (merged[k] == null || (merged as Record<string, string>)[k] === '') {
      ;(merged as Record<string, string>)[k] = '0'
    }
  })
  // Provide default for SGLANG_MAX_RUNNING_REQUESTS when not provided
  if (
    merged.SGLANG_MAX_RUNNING_REQUESTS == null
    || (merged as Record<string, string>).SGLANG_MAX_RUNNING_REQUESTS === ''
  ) {
    ;(merged as Record<string, string>).SGLANG_MAX_RUNNING_REQUESTS = '0'
  }
  // Provide default for SGLANG_CONTEXT_LENGTH when not provided
  if (merged.SGLANG_CONTEXT_LENGTH == null || (merged as Record<string, string>).SGLANG_CONTEXT_LENGTH === '') {
    ;(merged as Record<string, string>).SGLANG_CONTEXT_LENGTH = '0'
  }
  if (merged.CODEX_CONTEXT_LENGTH == null || (merged as Record<string, string>).CODEX_CONTEXT_LENGTH === '') {
    ;(merged as Record<string, string>).CODEX_CONTEXT_LENGTH = '0'
  }
  if (
    merged.JUDGMENTS_READY_TARGET_MULTIPLIER == null
    || (merged as Record<string, string>).JUDGMENTS_READY_TARGET_MULTIPLIER === ''
  ) {
    ;(merged as Record<string, string>).JUDGMENTS_READY_TARGET_MULTIPLIER = '10'
  }
  if (
    merged.JUDGMENTS_ADD_TO_QUEUE_MAX_BATCH_SIZE == null
    || (merged as Record<string, string>).JUDGMENTS_ADD_TO_QUEUE_MAX_BATCH_SIZE === ''
  ) {
    ;(merged as Record<string, string>).JUDGMENTS_ADD_TO_QUEUE_MAX_BATCH_SIZE = '10000'
  }
  if (!('WORKER_URLS' in merged)) {
    ;(merged as Record<string, undefined>).WORKER_URLS = undefined
  }
  // Ensure optional BETTER_AUTH_URL key exists even when not provided
  if (!('BETTER_AUTH_URL' in merged)) {
    ;(merged as Record<string, undefined>).BETTER_AUTH_URL = undefined
  }
  // Provide a stable default when GPU_SHAPE is not provided
  if (merged.GPU_SHAPE == null || String(merged.GPU_SHAPE).trim() === '') {
    ;(merged as Record<string, string>).GPU_SHAPE = 'not set'
  }
  // Provide a stable default when SGLANG_MODEL is not provided
  if (merged.SGLANG_MODEL == null || String(merged.SGLANG_MODEL).trim() === '') {
    ;(merged as Record<string, string>).SGLANG_MODEL = 'not set'
  }
  // Provide a stable default when DOCLING_SERVE_URL is not provided
  if (merged.DOCLING_SERVE_URL == null || String(merged.DOCLING_SERVE_URL).trim() === '') {
    ;(merged as Record<string, string>).DOCLING_SERVE_URL = 'http://localhost:5001'
  }
  if (merged.FULL_TEXT_CONVERSION_BATCH_SIZE == null || String(merged.FULL_TEXT_CONVERSION_BATCH_SIZE).trim() === '') {
    ;(merged as Record<string, string>).FULL_TEXT_CONVERSION_BATCH_SIZE = '5'
  }
  if (
    merged.FULL_TEXT_CONVERSION_CONCURRENCY == null
    || String(merged.FULL_TEXT_CONVERSION_CONCURRENCY).trim() === ''
  ) {
    ;(merged as Record<string, string>).FULL_TEXT_CONVERSION_CONCURRENCY = '1'
  }
  return envShape.assert(merged)
}

export const env = loadEnv()
