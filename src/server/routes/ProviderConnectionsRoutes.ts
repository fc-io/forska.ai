import {Elysia, t} from 'elysia'

import {getCodexMaxInflight} from '../cron/judgmentsJobs/getCodexMaxInflight.ts'
import {getJudgmentsCapacity} from '../cron/judgmentsJobs/getJudgmentsCapacity.ts'
import {
  getJudgmentEndpointAvailability,
  getJudgmentEndpointAvailabilityDiagnostics,
} from '../cron/judgmentsJobs/judgmentEndpointAvailability.ts'
import {
  beginProviderAuth,
  finishProviderAuth,
  getProviderAuthConnection,
  resolveMatchedProviderRuntimeCredentials,
} from '../providers/providerAuthService.ts'
import {getProviderConnectionAuthMode, getResolvedProviderBaseURL} from '../providers/providerConnectionHelpers.ts'
import {
  createProviderConnection,
  deleteProviderConnection,
  getProviderConnection,
  listProviderConnections,
  updateProviderConnection,
} from '../providers/providerConnectionRepository.ts'
import {testProviderConnectionHealth} from '../providers/providerHealthService.ts'
import {requireProviderRegistryEntry} from '../providers/providerRegistry.ts'
import {
  getDetectedProviderRuntimeSummaries,
  getDetectedProviderRuntimeSummary,
} from '../providers/providerRuntimeDetector.ts'
import {resolveProviderConnectionRuntimeMatchFromSummaries} from '../providers/providerRuntimeMatchResolver.ts'
import {getProviderConnectionWorkerState} from '../providers/providerRuntimeState.ts'
import {deleteProviderSecret, storeProviderSecret} from '../providers/providerSecretStore.ts'
import {
  type ProviderAuthLifecyclePayload,
  type ProviderConnectionRuntimeState,
  type ProviderRuntimeMatch,
  type ProviderRuntimeSourceMetadata,
} from '../providers/providerTypes.ts'
import {
  getProviderCatalog,
  getProviderCatalogEntry,
  isCodexProvider,
  normalizeProviderKind,
} from '../services/providerCatalog.ts'
import {HttpError} from '../utils/httpError.ts'
import {withErrorHandler} from '../utils/routeErrorHandler'
import {
  getProviderConnectionConfig,
  getProviderConnectionLabel,
  getPublicProviderConnection,
  getTrimmedValue,
} from './providerRoutes/providerRoutesShared.ts'

const getSubmittedManualWorkerUrls = ({
  manualWorkerUrls,
  workerUrls,
}: {
  manualWorkerUrls?: string[]
  workerUrls?: string[]
}) => {
  return manualWorkerUrls ?? workerUrls
}

const getSavedModelIds = (models: Array<{modelName: string | null; remoteModelId: string | null}>): string[] => {
  return models.flatMap((model) => {
    return [model.remoteModelId, model.modelName].filter((value): value is string => {
      return Boolean(value)
    })
  })
}

const getMaxInflightRequests = (value: number | null | undefined): number | null => {
  if (value === null || value === undefined) {
    return null
  }

  if (!Number.isInteger(value) || value <= 0) {
    throw new HttpError(400, 'maxInflightRequests must be null or a positive integer')
  }

  return value
}

const getEffectiveMaxInflightRequests = ({
  maxInflightRequests,
  providerKind,
}: {
  maxInflightRequests: number | null
  providerKind: string
}): number => {
  return (
    maxInflightRequests ?? (isCodexProvider(providerKind) ? getCodexMaxInflight() : getJudgmentsCapacity(1).maxInflight)
  )
}

const getPublicProviderConnectionPayload = <
  T extends {
    baseURL: string | null
    config: {llamaCppMode?: 'cli' | 'server'; manualWorkerUrls: string[]; workerUrlMode: 'manual' | 'runtime'}
    maxInflightRequests: number | null
    models?: Array<{modelName: string | null; remoteModelId: string | null}>
    providerKind: string
    secretRef: string | null
  },
>(
  connection: T,
) => {
  return {
    ...getPublicProviderConnection(connection),
    effectiveMaxInflightRequests: getEffectiveMaxInflightRequests(connection),
    workerState: getProviderConnectionWorkerState({
      baseURL: connection.baseURL,
      config: connection.config,
      providerKind: connection.providerKind,
      savedModelIds: getSavedModelIds(connection.models ?? []),
    }),
  }
}

const getRuntimeSourceLabel = (sourceMetadata: ProviderRuntimeSourceMetadata | null): string => {
  return sourceMetadata?.label ?? 'local'
}

const getRuntimeStatusLabel = ({
  sourceMetadata,
  status,
}: {
  sourceMetadata: ProviderRuntimeSourceMetadata | null
  status: ProviderRuntimeMatch['status']
}): string => {
  return status === 'matched'
    ? `matched ${getRuntimeSourceLabel(sourceMetadata)}`
    : status === 'manual-only'
      ? 'manual-only'
      : status === 'ambiguous'
        ? 'ambiguous'
        : 'unreachable'
}

const getRuntimeReasonLabel = ({
  reason,
  sourceMetadata,
}: {
  reason: ProviderRuntimeMatch['reason']
  sourceMetadata: ProviderRuntimeSourceMetadata | null
}): string => {
  const sourceLabel = getRuntimeSourceLabel(sourceMetadata)

  return reason === 'manual-mode'
    ? 'This connection is using saved manual settings.'
    : reason === 'manual-base-url'
      ? 'This connection is using its saved base URL.'
      : reason === 'manual-provider'
        ? 'This connection is using its saved provider settings.'
        : reason === 'manual-worker-url'
          ? 'This connection is using its saved manual worker URLs.'
          : reason === 'runtime-base-url-overlap'
            ? 'The saved base URL overlaps the detected runtime URL.'
            : reason === 'no-saved-url'
              ? 'This connection has no saved base URL or manual worker URLs.'
              : reason === 'runtime-auto-detect'
                ? `Auto-detect matched the active ${sourceLabel} runtime.`
                : reason === 'runtime-model-overlap'
                  ? 'A saved model on this connection is currently served by the detected runtime.'
                  : reason === 'runtime-provider-mismatch'
                    ? 'A runtime is active, but it is for another provider kind.'
                    : reason === 'runtime-provider-missing'
                      ? 'No active runtime was detected for this provider kind.'
                      : reason === 'runtime-url-conflict'
                        ? 'Saved URLs or detected runtime targets conflict, so Forska cannot pick a single runtime.'
                        : reason === 'runtime-url-missing'
                          ? 'A runtime was detected, but its URLs do not overlap this connection.'
                          : reason === 'runtime-worker-url-overlap'
                            ? 'The saved manual worker URLs overlap the detected runtime worker URLs.'
                            : 'A runtime was detected, but it does not expose reachable worker URLs.'
}

const getProviderConnectionRuntimeState = ({
  connection,
  runtimeSummaries,
}: {
  connection: {
    baseURL: string | null
    config: {manualWorkerUrls: string[]; workerUrlMode: 'manual' | 'runtime'}
    id: string
    models: Array<{modelName: string | null; remoteModelId: string | null}>
    providerKind: string
  }
  runtimeSummaries: Awaited<ReturnType<typeof getDetectedProviderRuntimeSummaries>>
}): ProviderConnectionRuntimeState => {
  const match: ProviderRuntimeMatch = resolveProviderConnectionRuntimeMatchFromSummaries({
    baseURL: connection.baseURL,
    config: connection.config,
    providerKind: connection.providerKind,
    runtimeSummaries,
    savedModelIds: getSavedModelIds(connection.models),
  })
  const endpointAvailability = match.effectiveBaseURL
    ? getJudgmentEndpointAvailabilityDiagnostics(
        getJudgmentEndpointAvailability({
          effectiveBaseURL: match.effectiveBaseURL,
          providerConnectionId: connection.id,
        }),
      )
    : null

  return {
    detectedModelNames: match.detectedModelNames,
    endpointAvailability,
    effectiveBaseURL: match.effectiveBaseURL,
    effectiveWorkerUrls: match.effectiveWorkerUrls,
    reason: match.reason,
    reasonLabel: getRuntimeReasonLabel({reason: match.reason, sourceMetadata: match.sourceMetadata}),
    reasonLabels: match.reasons.map((reason) => {
      return getRuntimeReasonLabel({reason, sourceMetadata: match.sourceMetadata})
    }),
    sourceMetadata: match.sourceMetadata,
    status: match.status,
    statusLabel: getRuntimeStatusLabel({sourceMetadata: match.sourceMetadata, status: match.status}),
  }
}

const getProviderConnectionsPayload = async () => {
  const connections = await listProviderConnections()
  const runtime = await getDetectedProviderRuntimeSummary()
  const runtimeSummaries = await getDetectedProviderRuntimeSummaries()

  return {
    catalog: getProviderCatalog(),
    connections: connections.map((connection) => {
      return {
        ...getPublicProviderConnection(connection),
        effectiveMaxInflightRequests: getEffectiveMaxInflightRequests(connection),
        runtimeState: getProviderConnectionRuntimeState({connection, runtimeSummaries}),
        workerState: getProviderConnectionWorkerState({
          baseURL: connection.baseURL,
          config: connection.config,
          providerKind: connection.providerKind,
          runtimeSummary: runtime,
          savedModelIds: getSavedModelIds(connection.models),
        }),
      }
    }),
    runtime,
  }
}

export const providerConnectionsRoutes = new Elysia()
  .use(withErrorHandler())
  .post(
    '/api/provider-auth/:providerKind/begin',
    async ({body, params, set}) => {
      const providerKind = normalizeProviderKind(params.providerKind)

      if (providerKind === 'unknown') {
        set.status = 400
        return {data: null, error: 'Unsupported provider'}
      }

      const connection = await getProviderAuthConnection(body.connectionId ?? null)
      const result = await beginProviderAuth({connection, providerKind})

      return {
        data: {
          result: {...result, connection: result.connection ? getPublicProviderConnection(result.connection) : null},
        },
        error: null,
      }
    },
    {body: t.Object({connectionId: t.Optional(t.String())}), params: t.Object({providerKind: t.String()})},
  )
  .post(
    '/api/provider-auth/:providerKind/finish',
    async ({body, params, set}) => {
      const providerKind = normalizeProviderKind(params.providerKind)

      if (providerKind === 'unknown') {
        set.status = 400
        return {data: null, error: 'Unsupported provider'}
      }

      const connection = await getProviderAuthConnection(body.connectionId ?? null)
      const payload = (body.payload ?? null) as ProviderAuthLifecyclePayload | null
      const result = await finishProviderAuth({connection, payload, providerKind})

      return {
        data: {
          result: {...result, connection: result.connection ? getPublicProviderConnection(result.connection) : null},
        },
        error: null,
      }
    },
    {
      body: t.Object({connectionId: t.Optional(t.String()), payload: t.Optional(t.Any())}),
      params: t.Object({providerKind: t.String()}),
    },
  )
  .get('/api/provider-connections', async () => {
    return {data: await getProviderConnectionsPayload(), error: null}
  })
  .post(
    '/api/provider-connections',
    async ({body, set}) => {
      const providerKind = normalizeProviderKind(body.providerKind)
      const catalogEntry = getProviderCatalogEntry(providerKind)
      const apiKey = getTrimmedValue(body.apiKey)

      if (providerKind === 'unknown' || !catalogEntry) {
        set.status = 400
        return {data: null, error: 'Unsupported provider'}
      }

      if (catalogEntry.requiresApiKey && !apiKey) {
        set.status = 400
        return {data: null, error: `${catalogEntry.label} API key is required`}
      }

      const baseURL = isCodexProvider(providerKind)
        ? null
        : getResolvedProviderBaseURL({baseURL: getTrimmedValue(body.baseURL), providerKind})
      const label = getProviderConnectionLabel({label: body.label, providerKind})
      const config = getProviderConnectionConfig({
        llamaCppMode: getTrimmedValue(body.llamaCppMode),
        manualWorkerUrls: getSubmittedManualWorkerUrls(body),
        providerKind,
        workerUrlMode: getTrimmedValue(body.workerUrlMode),
      })
      const connection = await createProviderConnection({
        authMode: getProviderConnectionAuthMode({baseURL, providerKind, secretRef: null}),
        baseURL,
        config,
        label,
        maxInflightRequests: getMaxInflightRequests(body.maxInflightRequests),
        providerKind,
        secretRef: null,
      })

      try {
        const secretRef = apiKey ? await storeProviderSecret({connectionId: connection.id, secret: apiKey}) : null
        const savedConnection = secretRef
          ? await updateProviderConnection({
              authMode: getProviderConnectionAuthMode({baseURL, providerKind, secretRef}),
              baseURL,
              config,
              enabled: connection.enabled,
              id: connection.id,
              label,
              maxInflightRequests: connection.maxInflightRequests,
              secretRef,
            })
          : connection

        return {data: {connection: getPublicProviderConnectionPayload({...savedConnection, models: []})}, error: null}
      } catch (error) {
        await deleteProviderConnection(connection.id).catch(() => {
          return null
        })
        throw error
      }
    },
    {
      body: t.Object({
        apiKey: t.Optional(t.String()),
        baseURL: t.Optional(t.Union([t.String(), t.Null()])),
        label: t.Optional(t.String()),
        llamaCppMode: t.Optional(t.Union([t.Literal('cli'), t.Literal('server')])),
        manualWorkerUrls: t.Optional(t.Array(t.String())),
        maxInflightRequests: t.Optional(t.Union([t.Number(), t.Null()])),
        providerKind: t.String(),
        workerUrls: t.Optional(t.Array(t.String())),
        workerUrlMode: t.Optional(t.Union([t.Literal('manual'), t.Literal('runtime')])),
      }),
    },
  )
  .patch(
    '/api/provider-connections/:id',
    async ({body, params, set}) => {
      const existing = await getProviderConnection(params.id)

      if (!existing) {
        set.status = 404
        return {data: null, error: 'Provider connection not found'}
      }

      const nextBaseURL = isCodexProvider(existing.providerKind)
        ? null
        : getResolvedProviderBaseURL({
            baseURL: body.baseURL !== undefined ? getTrimmedValue(body.baseURL) : existing.baseURL,
            providerKind: existing.providerKind,
          })
      const nextLabel = getProviderConnectionLabel({
        label: body.label !== undefined ? body.label : existing.label,
        providerKind: existing.providerKind,
      })
      const nextConfig = getProviderConnectionConfig({
        llamaCppMode: getTrimmedValue(body.llamaCppMode) ?? existing.config.llamaCppMode,
        manualWorkerUrls: getSubmittedManualWorkerUrls(body) ?? existing.config.manualWorkerUrls,
        providerKind: existing.providerKind,
        workerUrlMode: getTrimmedValue(body.workerUrlMode) ?? existing.config.workerUrlMode,
      })
      const shouldClearExistingSecret = body.clearSecret === true
      const nextStoredApiKey = getTrimmedValue(body.apiKey)
      const secretRef = nextStoredApiKey
        ? await storeProviderSecret({connectionId: existing.id, secret: nextStoredApiKey})
        : shouldClearExistingSecret
          ? null
          : existing.secretRef

      try {
        const updated = await updateProviderConnection({
          authMode: getProviderConnectionAuthMode({
            baseURL: nextBaseURL,
            providerKind: existing.providerKind,
            secretRef,
          }),
          baseURL: nextBaseURL,
          config: nextConfig,
          enabled: body.enabled ?? existing.enabled,
          id: existing.id,
          label: nextLabel,
          maxInflightRequests:
            body.maxInflightRequests !== undefined
              ? getMaxInflightRequests(body.maxInflightRequests)
              : existing.maxInflightRequests,
          secretRef,
        })

        if (nextStoredApiKey && existing.secretRef && existing.secretRef !== secretRef) {
          await deleteProviderSecret(existing.secretRef).catch(() => {
            return null
          })
        }

        if (shouldClearExistingSecret && existing.secretRef && existing.secretRef !== secretRef) {
          await deleteProviderSecret(existing.secretRef).catch(() => {
            return null
          })
        }

        return {data: {connection: getPublicProviderConnectionPayload(updated)}, error: null}
      } catch (error) {
        if (nextStoredApiKey && secretRef) {
          await deleteProviderSecret(secretRef).catch(() => {
            return null
          })
        }

        throw error
      }
    },
    {
      body: t.Object({
        apiKey: t.Optional(t.String()),
        baseURL: t.Optional(t.Union([t.String(), t.Null()])),
        clearSecret: t.Optional(t.Boolean()),
        enabled: t.Optional(t.Boolean()),
        label: t.Optional(t.String()),
        llamaCppMode: t.Optional(t.Union([t.Literal('cli'), t.Literal('server')])),
        manualWorkerUrls: t.Optional(t.Array(t.String())),
        maxInflightRequests: t.Optional(t.Union([t.Number(), t.Null()])),
        workerUrls: t.Optional(t.Array(t.String())),
        workerUrlMode: t.Optional(t.Union([t.Literal('manual'), t.Literal('runtime')])),
      }),
      params: t.Object({id: t.String()}),
    },
  )
  .delete(
    '/api/provider-connections/:id',
    async ({params, set}) => {
      const connection = await getProviderConnection(params.id)

      if (!connection) {
        set.status = 404
        return {data: null, error: 'Provider connection not found'}
      }

      try {
        const result = await deleteProviderConnection(connection.id)

        if (connection.secretRef) {
          await deleteProviderSecret(connection.secretRef).catch((error) => {
            console.warn(
              '[provider-connections] Failed to delete provider secret:',
              error instanceof Error ? error.message : error,
            )
          })
        }

        return {data: result, error: null}
      } catch (error) {
        set.status = 400
        return {data: null, error: error instanceof Error ? error.message : 'Failed to remove provider connection'}
      }
    },
    {params: t.Object({id: t.String()})},
  )
  .post(
    '/api/provider-connections/:id/test',
    async ({params, set}) => {
      const connection = await getProviderConnection(params.id)

      if (!connection) {
        set.status = 404
        return {data: null, error: 'Provider connection not found'}
      }

      try {
        const result = await testProviderConnectionHealth(connection)

        if (!result.ok) {
          set.status = 400
          return {data: null, error: result.message}
        }

        return {data: {message: result.message, modelCount: result.modelCount}, error: null}
      } catch (error) {
        set.status = 400
        return {data: null, error: error instanceof Error ? error.message : 'Provider connection test failed'}
      }
    },
    {params: t.Object({id: t.String()})},
  )
  .get(
    '/api/provider-connections/:id/discovered-models',
    async ({params, set}) => {
      const connection = await getProviderConnection(params.id)

      if (!connection) {
        set.status = 404
        return {data: null, error: 'Provider connection not found'}
      }

      try {
        const definition = requireProviderRegistryEntry(connection.providerKind)
        const runtimeCredentials = await resolveMatchedProviderRuntimeCredentials(connection)
        const models = await definition.listModels({connection, runtimeCredentials})

        return {data: {models}, error: null}
      } catch (error) {
        set.status = 400
        return {data: null, error: error instanceof Error ? error.message : 'Provider model discovery failed'}
      }
    },
    {params: t.Object({id: t.String()})},
  )
