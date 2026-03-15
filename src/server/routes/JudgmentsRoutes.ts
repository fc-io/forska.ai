import {Elysia} from 'elysia'

import {getAppDatabaseService} from '../services/appDatabaseService.ts'
import {escapeSqlString, getJsonValue, getQuotedStringList, getSqlLiteral} from '../services/appQueryHelpers.ts'
import {env} from '../utils/env.ts'

type ModelRow = {
  id: string
  name: string
  provider: string | null
  baseURL: string | null
  modelName: string | null
  version: string | null
  apiKeyVariable: string | null
  workerUrls: string[] | null
  createdAt: string | null
  updatedAt: string | null
}

const normalizeWorkerUrls = (urls: string[] | null | undefined): string[] => {
  return Array.from(
    new Set(
      (urls ?? [])
        .map((url) => {
          return url.trim()
        })
        .filter((url) => {
          return url.length > 0
        }),
    ),
  )
}

const envWorkerUrls = normalizeWorkerUrls(env.WORKER_URLS)

const syncWorkerUrls = async (modelRow: ModelRow | undefined | null) => {
  if (!modelRow) return modelRow
  if (envWorkerUrls.length === 0) return modelRow
  const existing = normalizeWorkerUrls(modelRow.workerUrls)
  const differs =
    existing.length !== envWorkerUrls.length
    || envWorkerUrls.some((url) => {
      return !existing.includes(url)
    })
  if (!differs) return modelRow
  const [updated] = await getAppDatabaseService().queryJson<{
    id: string
    name: string
    provider: string | null
    baseURL: string | null
    modelName: string | null
    version: string | null
    apiKeyVariable: string | null
    workerUrls: unknown
    createdAt: string | null
    updatedAt: string | null
  }>(`
    UPDATE app.model
    SET worker_urls = ${getSqlLiteral(envWorkerUrls)},
        updated_at = current_timestamp
    WHERE id = '${escapeSqlString(modelRow.id)}'
    RETURNING
      id,
      name,
      provider,
      base_url AS baseURL,
      model_name AS modelName,
      version,
      api_key_variable AS apiKeyVariable,
      TO_JSON(worker_urls) AS workerUrls,
      created_at AS createdAt,
      updated_at AS updatedAt
  `)
  return updated ? {...updated, workerUrls: getJsonValue(updated.workerUrls) as string[] | null} : modelRow
}

export const judgmentsRoutes = new Elysia().get('/api/judgments/model', async ({query}) => {
  try {
    const modelName = query.name || 'Qwen3-32B-FP8'
    const provider = query.provider || 'SGLang'
    const baseURL = query.baseURL || 'http://localhost:30000/v1'

    // Check if model exists
    const [existingModel] = await getAppDatabaseService().queryJson<ModelRow>(`
      SELECT
        id,
        name,
        provider,
        base_url AS baseURL,
        model_name AS modelName,
        version,
        api_key_variable AS apiKeyVariable,
        worker_urls AS workerUrls,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM app.model
      WHERE name = ${getSqlLiteral(modelName)}
        AND provider = ${getSqlLiteral(provider)}
        AND base_url = ${getSqlLiteral(baseURL)}
      LIMIT 1
    `)

    const persistedModel =
      existingModel
      ?? (
        await getAppDatabaseService().queryJson<ModelRow>(`
          INSERT INTO app.model (id, name, provider, base_url, model_name, version)
          VALUES (${getQuotedStringList([crypto.randomUUID(), modelName, provider, baseURL, '/models/Qwen3-32B-FP8', '1.0.0']).join(', ')})
          RETURNING
            id,
            name,
            provider,
            base_url AS baseURL,
            model_name AS modelName,
            version,
            api_key_variable AS apiKeyVariable,
            worker_urls AS workerUrls,
            created_at AS createdAt,
            updated_at AS updatedAt
        `)
      )[0]

    if (!persistedModel) {
      throw new Error('Failed to ensure model record')
    }

    const syncedModel = await syncWorkerUrls(persistedModel)

    return {success: true, data: syncedModel}
  } catch (error) {
    console.error('Error getting/creating model:', error)
    return {success: false, error: 'Failed to get/create model'}
  }
})
