import {Elysia, t} from 'elysia'

import {getProviderConnection} from '../providers/providerConnectionRepository.ts'
import {createProviderModel, updateProviderModel} from '../providers/providerModelRepository.ts'
import {syncProviderConnectionModels} from '../providers/providerSyncService.ts'
import {getAppDatabaseService} from '../services/appDatabaseService.ts'
import {getSqlLiteral} from '../services/appQueryHelpers.ts'
import {withErrorHandler} from '../utils/routeErrorHandler'
import {getTrimmedValue} from './providerRoutes/providerRoutesShared.ts'

export const providerModelsRoutes = new Elysia()
  .use(withErrorHandler())
  .post(
    '/api/provider-connections/:id/sync-models',
    async ({params, set}) => {
      const connection = await getProviderConnection(params.id)

      if (!connection) {
        set.status = 404
        return {data: null, error: 'Provider connection not found'}
      }

      try {
        const result = await syncProviderConnectionModels(connection)

        return {data: {count: result.savedModels.length, models: result.savedModels}, error: null}
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Provider model sync failed'
        set.status = 400
        return {data: null, error: message}
      }
    },
    {params: t.Object({id: t.String()})},
  )
  .post(
    '/api/provider-connections/:id/models',
    async ({body, params, set}) => {
      const connection = await getProviderConnection(params.id)

      if (!connection) {
        set.status = 404
        return {data: null, error: 'Provider connection not found'}
      }

      const remoteModelId = getTrimmedValue(body.remoteModelId)

      if (!remoteModelId) {
        set.status = 400
        return {data: null, error: 'remoteModelId is required'}
      }

      const variant = getTrimmedValue(body.variant)
      const [existing] = await getAppDatabaseService().queryJson<{id: string}>(`
        SELECT id
        FROM app.model
        WHERE provider_connection_id = ${getSqlLiteral(connection.id)}
          AND remote_model_id = ${getSqlLiteral(remoteModelId)}
          AND ${variant ? `variant = ${getSqlLiteral(variant)}` : 'variant IS NULL'}
        LIMIT 1
      `)

      if (existing) {
        return {data: {model: null, modelId: existing.id}, error: null}
      }

      const model = await createProviderModel({
        connection,
        displayName: getTrimmedValue(body.displayName) ?? remoteModelId,
        metadataJson: null,
        modelName: remoteModelId,
        remoteModelId,
        source: 'manual',
        variant,
        version: variant,
      })

      return {data: {model, modelId: model.id}, error: null}
    },
    {
      body: t.Object({displayName: t.Optional(t.String()), remoteModelId: t.String(), variant: t.Optional(t.String())}),
      params: t.Object({id: t.String()}),
    },
  )
  .patch(
    '/api/models/:id',
    async ({body, params, set}) => {
      const displayName = getTrimmedValue(body.displayName)

      if (!displayName) {
        set.status = 400
        return {data: null, error: 'displayName is required'}
      }

      const model = await updateProviderModel({
        displayName,
        enabled: body.enabled,
        id: params.id,
        variant: getTrimmedValue(body.variant),
      })

      return {data: {model}, error: null}
    },
    {
      body: t.Object({displayName: t.String(), enabled: t.Boolean(), variant: t.Optional(t.String())}),
      params: t.Object({id: t.String()}),
    },
  )
