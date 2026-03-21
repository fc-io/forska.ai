import {type ModelSource} from '../../db/schemaTypes.ts'
import {type ProviderCatalogEntry, type ProviderKind} from '../services/providerCatalog.ts'

export type ProviderTransportFamily =
  | 'anthropic-messages'
  | 'codex-app'
  | 'gemini-generate-content'
  | 'ollama-native-discovery'
  | 'openai-chat'
  | 'openai-responses'

export type ProviderWorkerUrlMode = 'manual' | 'runtime'
export type ProviderWorkerSource = 'legacy' | 'manual' | 'none' | 'runtime'

export type ProviderConnectionConfig = {manualWorkerUrls: string[]; workerUrlMode: ProviderWorkerUrlMode}

export type ProviderConnectionRecord = {
  authMode: string | null
  baseURL: string | null
  config: ProviderConnectionConfig
  createdAt: Date | null
  enabled: boolean
  hasSecret: boolean
  id: string
  label: string
  lastCheckedAt: Date | null
  lastError: string | null
  providerKind: ProviderKind
  secretRef: string | null
  updatedAt: Date | null
}

export type ProviderModelRecord = {
  baseURL: string | null
  createdAt: Date | null
  displayName: string | null
  enabled: boolean
  id: string
  metadataJson: unknown
  modelName: string | null
  name: string
  provider: ProviderKind
  providerConnectionId: string | null
  remoteModelId: string | null
  source: ModelSource | null
  updatedAt: Date | null
  variant: string | null
  version: string | null
}

export type ProviderConnectionForAdmin = ProviderConnectionRecord & {models: ProviderModelRecord[]}

export type ProviderListedModel = {
  displayName: string
  metadataJson: unknown
  modelName: string
  remoteModelId: string
  variant: string | null
  version: string | null
}

export type ProviderUsageSnapshot = {completionTokens: number; promptTokens: number; totalTokens: number}

export type ProviderRuntimeCredentials = {
  apiKey: string | null
  baseURL: string | null
  headers: Record<string, string>
  secretRef: string | null
}

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
  connection?: ProviderConnectionRecord | null
  message: string
  payload: ProviderAuthLifecyclePayload | null
  status: 'complete' | 'pending' | 'unsupported'
}

export type ProviderHealthResult = {lastError: string | null; message: string; modelCount: number | null; ok: boolean}

export type ProviderAuthContext = {catalog: ProviderCatalogEntry; connection: ProviderConnectionRecord}

export type ProviderBeginAuthInput = {connection: ProviderConnectionRecord | null; providerKind: ProviderKind}

export type ProviderFinishAuthInput = {
  connection: ProviderConnectionRecord | null
  payload: ProviderAuthLifecyclePayload | null
  providerKind: ProviderKind
}

export type ProviderListModelsInput = {
  connection: ProviderConnectionRecord
  runtimeCredentials: ProviderRuntimeCredentials
}

export type ProviderManualModelInput = {displayName: string; remoteModelId: string; variant: string | null}

export type ProviderInvokeRequest = {
  maxCompletionTokens: number
  outputSchema: unknown
  prompt: string
  systemPrompt: string
  temperature: number
}

export type ProviderInvokeInput = {
  connection: ProviderConnectionRecord
  model: ProviderModelRecord
  request: ProviderInvokeRequest
  runtimeCredentials: ProviderRuntimeCredentials
}

export type ProviderInvocationResult = {text: string; usage: ProviderUsageSnapshot}

export type ProviderAdapter = {
  addManualModel?: (input: ProviderManualModelInput) => Promise<ProviderListedModel>
  beginAuth?: (input: ProviderBeginAuthInput) => Promise<ProviderAuthLifecycleResult>
  catalog: ProviderCatalogEntry
  finishAuth?: (input: ProviderFinishAuthInput) => Promise<ProviderAuthLifecycleResult>
  health: (input: ProviderListModelsInput) => Promise<ProviderHealthResult>
  invoke: (input: ProviderInvokeInput) => Promise<ProviderInvocationResult>
  listModels: (input: ProviderListModelsInput) => Promise<ProviderListedModel[]>
  parseUsage?: (usage: ProviderUsageSnapshot) => ProviderUsageSnapshot
  resolveRuntimeCredentials: (context: ProviderAuthContext) => Promise<ProviderRuntimeCredentials>
  testConnection: (input: ProviderListModelsInput) => Promise<ProviderHealthResult>
  transportFamily: ProviderTransportFamily
}

export type ProviderDefinition = ProviderAdapter & {kind: ProviderKind}
