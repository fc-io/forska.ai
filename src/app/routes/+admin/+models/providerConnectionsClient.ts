import {format, isValid} from 'date-fns'

import {apiClient} from '../../../../services/apiClient.ts'
import {handleApiResponse} from '../../../../services/utils/handleApiResponse.ts'

export type ProviderCatalogEntry = {
  defaultBaseURL: string | null
  description: string
  kind: string
  label: string
  requiresApiKey: boolean
  supportsDiscovery: boolean
  supportsWorkerUrls: boolean
}

export type ProviderRuntimeSummary = {providerKind: string | null; workerUrls: string[]}

export type ProviderConnectionWorkerState = {
  effectiveWorkerUrls: string[]
  runtimeWorkerUrls: string[]
  workerSource: 'legacy' | 'manual' | 'none' | 'runtime'
}

export type ProviderModel = {
  baseURL: string | null
  createdAt: string | Date | null
  displayName: string | null
  enabled: boolean
  id: string
  metadataJson: unknown
  modelName: string | null
  name: string
  provider: string
  providerConnectionId: string | null
  remoteModelId: string | null
  source: 'discovered' | 'manual' | null
  updatedAt: string | Date | null
  variant: string | null
  version: string | null
}

export type ProviderConnection = {
  authMode: string | null
  baseURL: string | null
  config: {manualWorkerUrls: string[]; workerUrlMode: 'manual' | 'runtime'}
  createdAt: string | Date | null
  enabled: boolean
  hasSecret: boolean
  id: string
  label: string
  lastCheckedAt: string | Date | null
  lastError: string | null
  models: ProviderModel[]
  providerKind: string
  updatedAt: string | Date | null
  workerState: ProviderConnectionWorkerState
}

type ProviderConnectionsPayload = {
  catalog: ProviderCatalogEntry[]
  connections: ProviderConnection[]
  runtime: ProviderRuntimeSummary
}
type ProviderConnectionsResponse = {data: ProviderConnectionsPayload; error: null}
type ProviderConnectionMutationResponse = {data: {connection: ProviderConnection}; error: null}
type ProviderConnectionDeleteResponse = {
  data: {
    comparisonProjectCount: number
    deleted: boolean
    deletedModelCount: number
    judgmentCount: number
    projectCount: number
  }
  error: null
}
type ProviderConnectionTestResponse = {data: {message: string; modelCount: number | null}; error: null}
type ProviderConnectionSyncResponse = {data: {count: number; models: ProviderModel[]}; error: null}
type ProviderConnectionManualModelResponse = {data: {model: ProviderModel | null; modelId: string}; error: null}
type ProviderModelMutationResponse = {data: {model: ProviderModel}; error: null}

export type CodexCliStatus = {ok: boolean; loggedIn: boolean; method: 'chatgpt' | 'api-key' | null; raw: string}
export type CodexStatus = {codexBin: string; cli: CodexCliStatus; appServerReady: boolean; message: string}
type CodexStatusResponse = {data: CodexStatus; error: null}
export type CodexDeviceLoginJob = {
  id: string
  state: 'running' | 'completed' | 'failed'
  startedAt: string
  finishedAt: string | null
  exitCode: number | null
  signal: string | null
  output: string[]
  deviceUrl: string | null
  deviceCode: string | null
  error: string | null
}
type StartCodexLoginResponse = {data: {started: boolean; job: CodexDeviceLoginJob | null; message: string}; error: null}
type CodexLoginJobResponse = {data: CodexDeviceLoginJob; error: null}
export type ProviderAuthField = {label: string; name: string; optional?: boolean; required: boolean; secret: boolean}
export type ProviderAuthLifecyclePayload = {
  authMode: string | null
  fields?: ProviderAuthField[]
  hasStoredSecret?: boolean
  jobId?: string | null
  providerState?: unknown
  secretValue?: string | null
}
export type ProviderAuthLifecycleResult = {
  connection?: ProviderConnection | null
  message: string
  payload: ProviderAuthLifecyclePayload | null
  status: 'complete' | 'pending' | 'unsupported'
}
type ProviderAuthLifecycleResponse = {data: {result: ProviderAuthLifecycleResult}; error: null}

const postProviderAuthLifecycle = async ({
  body,
  providerKind,
  stage,
}: {
  body: {connectionId?: string; payload?: ProviderAuthLifecyclePayload | null}
  providerKind: string
  stage: 'begin' | 'finish'
}) => {
  const response = await fetch(`/api/provider-auth/${encodeURIComponent(providerKind)}/${stage}`, {
    body: JSON.stringify(body),
    headers: {'content-type': 'application/json'},
    method: 'POST',
  })
  const data = (await response.json()) as ProviderAuthLifecycleResponse
  const result = handleApiResponse<ProviderAuthLifecycleResponse>(
    {data, error: response.ok ? undefined : data, status: response.status},
    `Failed to ${stage} provider auth`,
  )

  return result.data.result
}

export const fetchProviderConnections = async () => {
  const response = await apiClient.api['provider-connections'].get()
  const result = handleApiResponse<ProviderConnectionsResponse>(response, 'Failed to load provider connections')

  return result.data
}

export const createProviderConnection = async (input: {
  apiKey?: string
  baseURL?: string | null
  label?: string
  manualWorkerUrls?: string[]
  providerKind: string
  workerUrlMode?: 'manual' | 'runtime'
}) => {
  const response = await apiClient.api['provider-connections'].post(input)
  const result = handleApiResponse<ProviderConnectionMutationResponse>(
    response as unknown as {data?: ProviderConnectionMutationResponse; error?: unknown; status?: number},
    'Failed to create provider connection',
  )

  return result.data.connection
}

export const updateProviderConnection = async (input: {
  apiKey?: string
  baseURL?: string | null
  clearSecret?: boolean
  enabled?: boolean
  id: string
  label?: string
  manualWorkerUrls?: string[]
  workerUrlMode?: 'manual' | 'runtime'
}) => {
  const response = await apiClient.api['provider-connections']({id: input.id}).patch({
    apiKey: input.apiKey,
    baseURL: input.baseURL,
    clearSecret: input.clearSecret,
    enabled: input.enabled,
    label: input.label,
    manualWorkerUrls: input.manualWorkerUrls,
    workerUrlMode: input.workerUrlMode,
  })
  const result = handleApiResponse<ProviderConnectionMutationResponse>(
    response as unknown as {data?: ProviderConnectionMutationResponse; error?: unknown; status?: number},
    'Failed to update provider connection',
  )

  return result.data.connection
}

export const deleteProviderConnection = async (id: string) => {
  const response = await apiClient.api['provider-connections']({id}).delete()
  const result = handleApiResponse<ProviderConnectionDeleteResponse>(
    response as unknown as {data?: ProviderConnectionDeleteResponse; error?: unknown; status?: number},
    'Failed to remove provider connection',
  )

  return result.data
}

export const testProviderConnectionApi = async (id: string) => {
  const response = await apiClient.api['provider-connections']({id}).test.post()
  const result = handleApiResponse<ProviderConnectionTestResponse>(
    response as unknown as {data?: ProviderConnectionTestResponse; error?: unknown; status?: number},
    'Failed to test provider connection',
  )

  return result.data
}

export const syncProviderConnectionModels = async (id: string) => {
  const response = await apiClient.api['provider-connections']({id})['sync-models'].post()
  const result = handleApiResponse<ProviderConnectionSyncResponse>(
    response as unknown as {data?: ProviderConnectionSyncResponse; error?: unknown; status?: number},
    'Failed to sync provider models',
  )

  return result.data
}

export const addManualProviderModel = async (input: {
  displayName?: string
  id: string
  remoteModelId: string
  variant?: string
}) => {
  const response = await apiClient.api['provider-connections']({id: input.id}).models.post({
    displayName: input.displayName,
    remoteModelId: input.remoteModelId,
    variant: input.variant,
  })
  const result = handleApiResponse<ProviderConnectionManualModelResponse>(
    response as unknown as {data?: ProviderConnectionManualModelResponse; error?: unknown; status?: number},
    'Failed to add model',
  )

  return result.data
}

export const updateProviderModel = async (input: {
  displayName: string
  enabled: boolean
  id: string
  variant?: string
}) => {
  const response = await apiClient.api
    .models({id: input.id})
    .patch({displayName: input.displayName, enabled: input.enabled, variant: input.variant})
  const result = handleApiResponse<ProviderModelMutationResponse>(
    response as unknown as {data?: ProviderModelMutationResponse; error?: unknown; status?: number},
    'Failed to update model',
  )

  return result.data.model
}

export const fetchCodexStatus = async () => {
  const response = await apiClient.api.models.codex.status.get()
  const result = handleApiResponse<CodexStatusResponse>(response, 'Failed to load Codex status')

  return result.data
}

export const startCodexLogin = async () => {
  const response = await apiClient.api.models.codex.login.post()
  const result = handleApiResponse<StartCodexLoginResponse>(response, 'Failed to start Codex login')

  return result.data
}

export const fetchCodexLoginJob = async (jobId: string) => {
  const response = await apiClient.api.models.codex.login({jobId}).get()
  const result = handleApiResponse<CodexLoginJobResponse>(
    response as unknown as {data?: CodexLoginJobResponse; error?: unknown; status?: number},
    'Failed to fetch Codex login job',
  )

  return result.data
}

export const beginProviderAuthLifecycle = async ({
  connectionId,
  providerKind,
}: {
  connectionId?: string
  providerKind: string
}): Promise<ProviderAuthLifecycleResult> => {
  return postProviderAuthLifecycle({body: {connectionId}, providerKind, stage: 'begin'})
}

export const finishProviderAuthLifecycle = async ({
  connectionId,
  payload,
  providerKind,
}: {
  connectionId?: string
  payload?: ProviderAuthLifecyclePayload | null
  providerKind: string
}): Promise<ProviderAuthLifecycleResult> => {
  return postProviderAuthLifecycle({body: {connectionId, payload}, providerKind, stage: 'finish'})
}

export const formatTimestamp = (value: string | Date | null) => {
  if (!value) {
    return '-'
  }

  const date = typeof value === 'string' ? new Date(value) : value
  return isValid(date) ? format(date, 'yyyy-MM-dd HH:mm:ss') : '-'
}

export const getWorkerUrlsInputValue = (workerUrls: string[] | null | undefined): string => {
  return workerUrls && workerUrls.length > 0 ? workerUrls.join(', ') : ''
}

export const supportsRuntimeWorkerUrls = (providerKind: string | null | undefined): boolean => {
  const normalizedProviderKind = String(providerKind ?? '')
    .trim()
    .toLowerCase()

  return normalizedProviderKind === 'sglang' || normalizedProviderKind === 'vllm'
}

export const getRuntimeWorkerUrlsForProvider = ({
  providerKind,
  runtime,
}: {
  providerKind: string | null | undefined
  runtime: ProviderRuntimeSummary | null | undefined
}): string[] => {
  const normalizedProviderKind = String(providerKind ?? '')
    .trim()
    .toLowerCase()
  const runtimeProviderKind = String(runtime?.providerKind ?? '')
    .trim()
    .toLowerCase()

  return runtimeProviderKind === normalizedProviderKind ? (runtime?.workerUrls ?? []) : []
}

const getJsonRecord = (value: unknown): Record<string, unknown> | null => {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

const getPositiveInteger = (value: unknown): number | null => {
  const numericValue = typeof value === 'number' ? value : Number(value)

  return Number.isFinite(numericValue) && numericValue > 0 ? Math.trunc(numericValue) : null
}

export const getProviderModelContextLength = (metadataJson: unknown): number | null => {
  const metadataRecord = getJsonRecord(metadataJson)
  const discovery = getJsonRecord(metadataRecord?.discovery)
  const contextWindow = getJsonRecord(discovery?.contextWindow)

  return getPositiveInteger(contextWindow?.totalTokens) ?? getPositiveInteger(contextWindow?.inputTokens)
}

export const getProviderModelDiscoverySource = (metadataJson: unknown): string | null => {
  const metadataRecord = getJsonRecord(metadataJson)
  const discovery = getJsonRecord(metadataRecord?.discovery)

  return typeof discovery?.source === 'string' ? discovery.source : null
}

export const getProviderModelReasoningEfforts = (metadataJson: unknown): string[] => {
  const metadataRecord = getJsonRecord(metadataJson)
  const discovery = getJsonRecord(metadataRecord?.discovery)
  const capabilities = getJsonRecord(discovery?.capabilities)
  const reasoningEfforts = Array.isArray(capabilities?.reasoningEfforts)
    ? capabilities.reasoningEfforts.filter((entry): entry is string => {
        return typeof entry === 'string' && entry.trim().length > 0
      })
    : []

  return reasoningEfforts
}

export const getWorkerSourceLabel = (workerSource: ProviderConnectionWorkerState['workerSource']): string => {
  return workerSource === 'runtime'
    ? 'Runtime-discovered'
    : workerSource === 'manual'
      ? 'Saved manual'
      : workerSource === 'legacy'
        ? 'Legacy saved'
        : 'None'
}

export const getWorkerUrlsFromInputValue = (value: string): string[] => {
  return Array.from(
    new Set(
      value
        .split(',')
        .map((part) => {
          return part.trim()
        })
        .filter((part) => {
          return part.length > 0
        }),
    ),
  )
}

export const getTrimmedValue = (value: string): string => {
  return value.trim()
}

export const getNullableTrimmedValue = (value: string): string | null => {
  const normalized = value.trim()

  return normalized === '' ? null : normalized
}

export const getFormDataString = (formData: FormData, key: string): string => {
  const value = formData.get(key)
  return typeof value === 'string' ? value : ''
}

export const getProviderSecretStatus = (connection: ProviderConnection | null | undefined): string => {
  if (!connection) {
    return 'No secret configured'
  }

  return connection.authMode === 'codex-cli'
    ? 'CLI auth'
    : connection.authMode === 'api-key'
      ? connection.hasSecret
        ? 'Key stored'
        : 'Key missing'
      : 'No secret required'
}

export const getProviderCatalogLabel = (
  catalog: ProviderCatalogEntry[],
  providerKind: string | null | undefined,
): string => {
  const normalizedProviderKind = String(providerKind ?? '')
    .trim()
    .toLowerCase()

  return (
    catalog.find((entry) => {
      return entry.kind === normalizedProviderKind
    })?.label
    ?? providerKind
    ?? 'Unknown'
  )
}
