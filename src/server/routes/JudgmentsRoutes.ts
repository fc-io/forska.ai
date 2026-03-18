import {Elysia} from 'elysia'

import {getAppDatabaseService} from '../services/appDatabaseService.ts'
import {getSqlLiteral} from '../services/appQueryHelpers.ts'
import {ensureProviderConnectionSeed} from '../services/ensureProviderConnectionSeed.ts'
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

export const judgmentsRoutes = new Elysia().get('/api/judgments/model', async ({query}) => {
  try {
    const modelName = query.name || 'Qwen3-32B-FP8'
    const provider = query.provider || 'SGLang'
    const baseURL = query.baseURL || 'http://localhost:30000/v1'

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
        await getAppDatabaseService().transaction(async (tx) => {
          const modelId = crypto.randomUUID()

          await ensureProviderConnectionSeed(tx, {
            baseURL,
            connectionId: modelId,
            label: modelName,
            provider,
            workerUrls: envWorkerUrls,
          })

          return tx.queryJson<ModelRow>(`
            INSERT INTO app.model (
              id,
              provider_connection_id,
              name,
              provider,
              base_url,
              model_name,
              remote_model_id,
              display_name,
              version,
              variant,
              source,
              enabled
            )
            VALUES (
              ${getSqlLiteral(modelId)},
              ${getSqlLiteral(modelId)},
              ${getSqlLiteral(modelName)},
              ${getSqlLiteral(provider)},
              ${getSqlLiteral(baseURL)},
              '/models/Qwen3-32B-FP8',
              '/models/Qwen3-32B-FP8',
              ${getSqlLiteral(modelName)},
              '1.0.0',
              '1.0.0',
              'manual',
              TRUE
            )
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
        })
      )[0]

    if (!persistedModel) {
      throw new Error('Failed to ensure model record')
    }

    return {success: true, data: persistedModel}
  } catch (error) {
    console.error('Error getting/creating model:', error)
    return {success: false, error: 'Failed to get/create model'}
  }
})
