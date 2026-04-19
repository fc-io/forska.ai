import {type ModelSource} from '../../db/schemaTypes.ts'
import {type ProviderModelOptions} from '../../utils/providerModelOptions.ts'
import {type ProviderCatalogEntry, type ProviderKind} from '../services/providerCatalog.ts'

export type ProviderTransportFamily =
  | 'anthropic-messages'
  | 'codex-app'
  | 'docling-convert'
  | 'gemini-generate-content'
  | 'ollama-native-discovery'
  | 'openai-chat'
  | 'openai-responses'

export type ProviderLlamaCppMode = 'cli' | 'server'
export type ProviderWorkerUrlMode = 'manual' | 'runtime'
export type ProviderWorkerSource = 'manual' | 'none' | 'runtime'
export type ProviderConnectionResolutionMode = 'auto-detect' | 'manual'
export type ProviderRuntimeCandidateSource = 'detected-runtime' | 'saved-base-url' | 'saved-manual-worker'
export type ProviderRuntimeCandidateStatus = 'available' | 'matched' | 'unavailable'
export type ProviderRuntimeMatchSource = ProviderRuntimeCandidateSource | 'none'
export type ProviderRuntimeMatchStatus = 'ambiguous' | 'manual-only' | 'matched' | 'unreachable'
export type ProviderRuntimeSourceKind = 'launcher' | 'local'
export type ProviderRuntimeMatchReason =
  | 'manual-mode'
  | 'manual-base-url'
  | 'manual-provider'
  | 'manual-worker-url'
  | 'runtime-base-url-overlap'
  | 'no-saved-url'
  | 'runtime-auto-detect'
  | 'runtime-model-overlap'
  | 'runtime-provider-mismatch'
  | 'runtime-provider-missing'
  | 'runtime-url-conflict'
  | 'runtime-url-missing'
  | 'runtime-worker-url-overlap'
  | 'runtime-worker-missing'

export type ProviderRuntimeSourceMetadata = {
  cluster: string | null
  jobId: string | null
  kind: ProviderRuntimeSourceKind
  label: string
  sshJumpHost: string | null
}

export type ProviderRuntimeCandidate = {
  localUrls: string[]
  modelNames: string[]
  reason: ProviderRuntimeMatchReason
  remoteUrls: string[]
  sourceMetadata: ProviderRuntimeSourceMetadata | null
  source: ProviderRuntimeCandidateSource
  status: ProviderRuntimeCandidateStatus
}

export type ProviderRuntimeMatch = {
  candidate: ProviderRuntimeCandidate | null
  detectedModelNames: string[]
  effectiveBaseURL: string | null
  effectiveWorkerUrls: string[]
  localUrls: string[]
  modelNames: string[]
  reason: ProviderRuntimeMatchReason
  reasons: ProviderRuntimeMatchReason[]
  remoteUrls: string[]
  resolutionMode: ProviderConnectionResolutionMode
  sourceMetadata: ProviderRuntimeSourceMetadata | null
  source: ProviderRuntimeMatchSource
  status: ProviderRuntimeMatchStatus
}

export type ProviderEndpointAvailabilityDiagnostics = {
  cooldownRemainingMs: number | null
  lastFailureKind:
    | 'network_unavailable'
    | 'endpoint_unavailable'
    | 'endpoint_misconfigured'
    | 'rate_limited'
    | 'circuit_open'
    | 'other'
    | null
  lastFailureMessage: string | null
  probeInProgress: boolean
  status: 'healthy' | 'cooldown' | 'probing' | 'misconfigured'
}

export type ProviderConnectionRuntimeState = {
  detectedModelNames: string[]
  endpointAvailability: ProviderEndpointAvailabilityDiagnostics | null
  effectiveBaseURL: string | null
  effectiveWorkerUrls: string[]
  reason: ProviderRuntimeMatchReason
  reasonLabel: string
  reasonLabels: string[]
  sourceMetadata: ProviderRuntimeSourceMetadata | null
  status: ProviderRuntimeMatchStatus
  statusLabel: string
}

export type ProviderConnectionConfig = {
  archived?: boolean
  disabledModelIds?: string[]
  llamaCppMode?: ProviderLlamaCppMode
  manualWorkerUrls: string[]
  workerUrlMode: ProviderWorkerUrlMode
}

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
  maxInflightRequests: number | null
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

export type ProviderInvocationDiagnostics = Record<string, unknown>

export class ProviderInvocationError extends Error {
  code: string
  diagnostics: ProviderInvocationDiagnostics | null
  providerKind: string | null
  usage: ProviderUsageSnapshot | null

  constructor(
    message: string,
    {
      cause,
      code,
      diagnostics,
      providerKind,
      usage,
    }: {
      cause?: unknown
      code: string
      diagnostics?: ProviderInvocationDiagnostics | null
      providerKind?: string | null
      usage?: ProviderUsageSnapshot | null
    },
  ) {
    super(message, {cause})
    this.name = 'ProviderInvocationError'
    this.code = code
    this.diagnostics = diagnostics ?? null
    this.providerKind = providerKind ?? null
    this.usage = usage ?? null
  }
}

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

export type ProviderManualModelInput = {
  displayName: string
  options?: ProviderModelOptions
  remoteModelId: string
  variant: string | null
}

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

export type ProviderInvocationResult = {stopReason?: string | null; text: string; usage: ProviderUsageSnapshot}

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
