import {Elysia} from 'elysia'

import {createProviderConnection} from '../providers/providerConnectionRepository.ts'
import {getManualProviderModelMetadata} from '../providers/providerModelMetadata.ts'
import {createProviderModel} from '../providers/providerModelRepository.ts'
import {getAppDatabaseService} from '../services/appDatabaseService.ts'
import {getSqlLiteral} from '../services/appQueryHelpers.ts'
import {normalizeProviderKind} from '../services/providerCatalog.ts'

type ModelRow = {
  id: string
  name: string
  provider: string | null
  baseURL: string | null
  modelName: string | null
  metadataJson: unknown
  version: string | null
  createdAt: string | null
  updatedAt: string | null
}

export const judgmentsRoutes = new Elysia().get('/api/judgments/model', async ({query}) => {
  try {
    const modelName = query.name || 'Qwen3-32B-FP8'
    const providerKind = normalizeProviderKind(query.provider || 'SGLang')
    const baseURL = query.baseURL || 'http://localhost:30000/v1'

    const [existingModel] = await getAppDatabaseService().queryJson<ModelRow>(`
      SELECT
        m.id,
        m.name,
        pc.provider_kind AS provider,
        pc.base_url AS baseURL,
        m.remote_model_id AS modelName,
        TO_JSON(m.metadata_json) AS metadataJson,
        m.variant AS version,
        m.created_at AS createdAt,
        m.updated_at AS updatedAt
      FROM app.model m
      INNER JOIN app.provider_connection pc ON pc.id = m.provider_connection_id
      WHERE m.name = ${getSqlLiteral(modelName)}
        AND pc.provider_kind = ${getSqlLiteral(providerKind)}
        AND pc.base_url = ${getSqlLiteral(baseURL)}
      LIMIT 1
    `)

    const persistedModel =
      existingModel
      ?? (await (async () => {
        const connection = await createProviderConnection({
          authMode: baseURL ? 'none' : null,
          baseURL,
          config: {manualWorkerUrls: [], workerUrlMode: 'manual'},
          label: modelName,
          maxInflightRequests: null,
          providerKind,
          secretRef: null,
        })

        return createProviderModel({
          connection,
          displayName: modelName,
          metadataJson: getManualProviderModelMetadata({
            displayName: modelName,
            modelName: '/models/Qwen3-32B-FP8',
            providerKind,
            remoteModelId: '/models/Qwen3-32B-FP8',
            variant: '1.0.0',
            version: '1.0.0',
          }),
          modelName: '/models/Qwen3-32B-FP8',
          remoteModelId: '/models/Qwen3-32B-FP8',
          source: 'manual',
          variant: '1.0.0',
          version: '1.0.0',
        })
      })())

    return {success: true, data: persistedModel}
  } catch (error) {
    console.error('Error getting/creating model:', error)
    return {success: false, error: 'Failed to get/create model'}
  }
})
