import {getSqlLiteral} from './appQueryHelpers.ts'

type DatabaseRunner = {run: (statement: string) => Promise<void>}

const getTrimmedValue = (value: string | null | undefined): string | null => {
  const normalized = String(value ?? '').trim()

  return normalized === '' ? null : normalized
}

const normalizeProviderKind = (value: string | null | undefined): string => {
  return getTrimmedValue(value)?.toLowerCase() ?? 'unknown'
}

const getProviderConnectionAuthMode = ({
  apiKeyVariable,
  baseURL,
  providerKind,
}: {
  apiKeyVariable: string | null | undefined
  baseURL: string | null | undefined
  providerKind: string
}): string | null => {
  return providerKind === 'codex'
    ? 'codex-cli'
    : getTrimmedValue(apiKeyVariable)
      ? 'env'
      : getTrimmedValue(baseURL)
        ? 'none'
        : null
}

const getProviderConnectionConfigJson = (workerUrls: string[] | null | undefined): string | null => {
  const normalizedWorkerUrls = Array.from(
    new Set(
      (workerUrls ?? [])
        .map((url) => {
          return String(url).trim()
        })
        .filter((url) => {
          return url.length > 0
        }),
    ),
  )

  return normalizedWorkerUrls.length > 0 ? JSON.stringify({workerUrls: normalizedWorkerUrls}) : null
}

const getJsonSqlLiteral = (value: string | null): string => {
  return value === null ? 'NULL' : `CAST(${getSqlLiteral(value)} AS JSON)`
}

export const ensureProviderConnectionSeed = async (
  databaseRunner: DatabaseRunner,
  {
    apiKeyVariable,
    baseURL,
    connectionId,
    label,
    provider,
    workerUrls,
  }: {
    apiKeyVariable?: string | null
    baseURL?: string | null
    connectionId: string
    label: string
    provider: string | null
    workerUrls?: string[] | null
  },
): Promise<void> => {
  const providerKind = normalizeProviderKind(provider)
  const configJson = getProviderConnectionConfigJson(workerUrls)
  const authMode = getProviderConnectionAuthMode({apiKeyVariable, baseURL, providerKind})
  const secretRef = getTrimmedValue(apiKeyVariable)

  await databaseRunner.run(`
    INSERT INTO app.provider_connection (
      id,
      provider_kind,
      label,
      enabled,
      auth_mode,
      base_url,
      config_json,
      secret_ref
    )
    SELECT
      ${getSqlLiteral(connectionId)},
      ${getSqlLiteral(providerKind)},
      ${getSqlLiteral(label)},
      TRUE,
      ${getSqlLiteral(authMode)},
      ${getSqlLiteral(getTrimmedValue(baseURL))},
      ${getJsonSqlLiteral(configJson)},
      ${getSqlLiteral(secretRef ? `env:${secretRef}` : null)}
    WHERE NOT EXISTS (
      SELECT 1
      FROM app.provider_connection
      WHERE id = ${getSqlLiteral(connectionId)}
    )
  `)
}
