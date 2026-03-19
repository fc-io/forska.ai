import {Elysia} from 'elysia'

import {getAppDatabaseService} from '../services/appDatabaseService.ts'
import {getSqlLiteral} from '../services/appQueryHelpers.ts'
import {ensureProviderConnectionSeed} from '../services/ensureProviderConnectionSeed.ts'

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

    const insertedModels = existingModel
      ? []
      : ((await getAppDatabaseService().transaction(async (tx) => {
          const modelId = crypto.randomUUID()

          await ensureProviderConnectionSeed(tx, {baseURL, connectionId: modelId, label: modelName, provider})

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
        })) as ModelRow[])
    const persistedModel = existingModel ?? insertedModels[0]

    if (!persistedModel) {
      throw new Error('Failed to ensure model record')
    }

    return {success: true, data: persistedModel}
  } catch (error) {
    console.error('Error getting/creating model:', error)
    return {success: false, error: 'Failed to get/create model'}
  }
})
