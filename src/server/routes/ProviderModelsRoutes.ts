import {Elysia, t} from 'elysia'

import {getProviderModelEffectiveVariant} from '../../utils/providerModelOptions.ts'
import {getProviderConnection} from '../providers/providerConnectionRepository.ts'
import {getManualProviderModelMetadata} from '../providers/providerModelMetadata.ts'
import {createProviderModel, updateProviderModel} from '../providers/providerModelRepository.ts'
import {syncProviderConnectionModels} from '../providers/providerSyncService.ts'
import {getAppDatabaseService} from '../services/appDatabaseService.ts'
import {getSqlLiteral} from '../services/appQueryHelpers.ts'
import type {DuckdbWorkloadContext} from '../utils/duckdbService.ts'
import {withErrorHandler} from '../utils/routeErrorHandler'
import {getTrimmedValue} from './providerRoutes/providerRoutesShared.ts'

const providerModelRouteWorkloadContext: DuckdbWorkloadContext = {
  fallbackIntent: 'reject',
  maxResultRows: 1,
  routeOrJobKey: 'providers.models.route.findExisting',
  workloadClass: 'owner.providerRepository',
}

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

      const variant = getProviderModelEffectiveVariant({
        options: body.options,
        provider: connection.providerKind,
        remoteModelId,
        variant: body.variant,
      })
      const displayName = getTrimmedValue(body.displayName) ?? remoteModelId
      const [existing] = await getAppDatabaseService().queryJson<{id: string}>(
        `
        SELECT id
        FROM app.model
        WHERE provider_connection_id = ${getSqlLiteral(connection.id)}
          AND remote_model_id = ${getSqlLiteral(remoteModelId)}
          AND ${variant ? `variant = ${getSqlLiteral(variant)}` : 'variant IS NULL'}
        LIMIT 1
      `,
        providerModelRouteWorkloadContext,
      )

      const model = existing
        ? await updateProviderModel({displayName, enabled: true, id: existing.id, options: body.options, variant})
        : await createProviderModel({
            connection,
            displayName,
            metadataJson: getManualProviderModelMetadata({
              displayName,
              modelName: remoteModelId,
              options: body.options,
              providerKind: connection.providerKind,
              remoteModelId,
              variant,
              version: variant,
            }),
            modelName: remoteModelId,
            remoteModelId,
            source: 'manual',
            variant,
            version: variant,
          })

      return {data: {model, modelId: model.id}, error: null}
    },
    {
      body: t.Object({
        displayName: t.Optional(t.String()),
        options: t.Optional(
          t.Object({
            thinking: t.Optional(t.Union([t.String(), t.Null()])),
            thinkingMode: t.Optional(t.Union([t.String(), t.Null()])),
          }),
        ),
        remoteModelId: t.String(),
        variant: t.Optional(t.String()),
      }),
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
        options: body.options,
        variant: getTrimmedValue(body.variant),
      })

      return {data: {model}, error: null}
    },
    {
      body: t.Object({
        displayName: t.String(),
        enabled: t.Boolean(),
        options: t.Optional(
          t.Object({
            thinking: t.Optional(t.Union([t.String(), t.Null()])),
            thinkingMode: t.Optional(t.Union([t.String(), t.Null()])),
          }),
        ),
        variant: t.Optional(t.String()),
      }),
      params: t.Object({id: t.String()}),
    },
  )
