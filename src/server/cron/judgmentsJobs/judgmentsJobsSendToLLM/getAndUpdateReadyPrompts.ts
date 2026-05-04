import {getProviderConnectionConfigFromJson} from '../../../providers/providerDbUtils.ts'
import {resolveProviderConnectionRuntimeMatch} from '../../../providers/providerRuntimeMatchResolver.ts'
import {getSqlLiteral} from '../../../services/appQueryHelpers.ts'
import {getJudgeWorkerReadOnlyAppDatabaseService} from '../../../services/appReadOnlyDatabaseService.ts'
import {
  claimOwnerJudgmentJobPrompts,
  getOwnerBackedJudgmentJobInfo,
  type OwnerBackedJudgmentJobInfo,
  recordAcceptedJudgeWorkerClaims,
  shouldUseJudgeWorkerOwnerHandoff,
} from '../judgeWorkerCompletionJournal.ts'
import {getJudgmentJobSqliteService, JudgmentJobLeaseError} from '../judgmentJobSqliteService.ts'

export type PromptToProcess = {
  jobId: string
  articleId: string
  claimId: string
  executionSnapshotHash: string
  executionSnapshotId: string
  promptId: string
  recordId: string
  projectId: string
  maxInflightRequests?: number | null
  modelId: string
  modelMetadataJson: unknown
  modelProvider: string
  modelSecretRef: string | null
  modelName: string
  modelVersion: string | null
  modelBaseUrl: string
  providerConnectionId: string | null
  providerFamily?: string
  providerId?: string
  providerKey?: string
  providerLimit?: number
  providerLimitVersion?: string
  providerMaxInflightRequests: number | null
  providerName?: string
  providerPromptBacklogTarget?: number | null
  providerUsesFamilyDefault: boolean
  resolvedDefaultCapacity?: number
  modelWorkerUrls: string[]
  useTitle: boolean
  useAbstract: boolean
  useFulltext: boolean
  useFulltextNoImages: boolean
}

export type PromptRuntime = {modelBaseUrl: string; modelProvider: string; modelWorkerUrls: string[]}

const normalizeProvider = (value: string | null | undefined): string => {
  const v = String(value ?? '')
    .trim()
    .toLowerCase()
  return v.length > 0 ? v : 'unknown'
}

const isCodexProvider = (provider: string): boolean => {
  return provider === 'codex'
}

const getCodexPlaceholderBaseUrl = (): string => {
  return 'codex://app-server'
}

const getCodexPromptRuntime = (): PromptRuntime => {
  return {modelBaseUrl: getCodexPlaceholderBaseUrl(), modelProvider: 'codex', modelWorkerUrls: []}
}

const getOwnerBackedPromptRuntime = (jobId: string, jobInfo: OwnerBackedJudgmentJobInfo): PromptRuntime | null => {
  if (jobInfo.resolvedRuntime) {
    return {
      modelBaseUrl: jobInfo.resolvedRuntime.modelBaseUrl,
      modelProvider: normalizeProvider(jobInfo.resolvedRuntime.modelProvider),
      modelWorkerUrls: jobInfo.resolvedRuntime.modelWorkerUrls,
    }
  }

  console.error('Prompt missing required owner-provided model runtime:', {
    jobId,
    modelName: jobInfo.modelName,
    modelProvider: jobInfo.modelProvider,
    runtimeMatchReason: jobInfo.runtimeMatchReason,
    runtimeResolutionMode: jobInfo.runtimeResolutionMode,
    runtimeStatus: jobInfo.runtimeMatchStatus,
  })

  return null
}

const isJobReadyToClaimPrompts = async (jobId: string): Promise<boolean> => {
  const [job] = await getJudgeWorkerReadOnlyAppDatabaseService().queryJson<{id: string}>(`
    SELECT id
    FROM app.judgment_job
    WHERE id = ${getSqlLiteral(jobId)}
      AND status = 'running'
      AND storage_state = 'active'
    LIMIT 1
  `)

  return Boolean(job)
}

const getModelRuntime = async ({
  baseURL,
  modelName,
  providerKind,
  providerConfigJson,
}: {
  baseURL: string | null
  modelName: string | null
  providerKind: string
  providerConfigJson: unknown
}): Promise<{
  baseURL: string | null
  reason: string
  resolutionMode: 'auto-detect' | 'manual'
  status: 'ambiguous' | 'manual-only' | 'matched' | 'unreachable'
  workerUrls: string[]
}> => {
  const config = getProviderConnectionConfigFromJson({providerKind, value: providerConfigJson})
  const runtimeMatch = await resolveProviderConnectionRuntimeMatch({
    baseURL,
    config,
    providerKind,
    savedModelIds: modelName ? [modelName] : [],
  })

  const shouldUseMatchedRuntime = runtimeMatch.resolutionMode === 'manual' || runtimeMatch.status === 'matched'

  return {
    baseURL: shouldUseMatchedRuntime ? runtimeMatch.effectiveBaseURL : null,
    reason: runtimeMatch.reason,
    resolutionMode: runtimeMatch.resolutionMode,
    status: runtimeMatch.status,
    workerUrls: shouldUseMatchedRuntime ? runtimeMatch.effectiveWorkerUrls : [],
  }
}

const getSqliteReadyRows = async (serverJobId: string, jobId: string, limit: number): Promise<PromptToProcess[]> => {
  const sqliteService = getJudgmentJobSqliteService()

  if (!(await isJobReadyToClaimPrompts(jobId))) {
    return []
  }

  try {
    await sqliteService.ensureOwnedLease(jobId, serverJobId)
  } catch (error) {
    if (error instanceof JudgmentJobLeaseError) {
      return []
    }

    throw error
  }

  const jobInfo = await sqliteService.getJobInfo(jobId)

  if (!jobInfo) {
    console.error('[getAndUpdateReadyPrompts] SQLite job info not found for jobId:', jobId)
    return []
  }

  const provider = normalizeProvider(jobInfo.modelProvider)

  if (isCodexProvider(provider)) {
    const claimedRows = await sqliteService.claimReadyPrompts(jobId, serverJobId, limit)
    const runtime = getCodexPromptRuntime()

    return claimedRows.map((prompt) => {
      return {
        ...prompt,
        modelBaseUrl: runtime.modelBaseUrl,
        modelMetadataJson: jobInfo.modelMetadataJson,
        modelName: jobInfo.modelName,
        modelProvider: provider,
        modelSecretRef: jobInfo.modelSecretRef,
        modelVersion: jobInfo.modelVersion,
        providerConnectionId: null,
        providerMaxInflightRequests: null,
        providerUsesFamilyDefault: true,
        modelWorkerUrls: runtime.modelWorkerUrls,
      }
    })
  }

  const runtime = await getModelRuntime({
    baseURL: jobInfo.modelBaseUrl,
    modelName: jobInfo.modelName,
    providerConfigJson: jobInfo.providerConfigJson,
    providerKind: provider,
  })

  if (!isCodexProvider(provider) && !runtime.baseURL) {
    console.error('Prompt missing required matched model baseURL:', {
      jobId,
      modelName: jobInfo.modelName,
      modelProvider: jobInfo.modelProvider,
      runtimeMatchReason: runtime.reason,
      runtimeResolutionMode: runtime.resolutionMode,
      runtimeStatus: runtime.status,
    })
    return []
  }

  const claimedRows = await sqliteService.claimReadyPrompts(jobId, serverJobId, limit)
  const baseUrl = String(runtime.baseURL)

  return claimedRows.map((prompt) => {
    return {
      ...prompt,
      modelBaseUrl: baseUrl,
      modelMetadataJson: jobInfo.modelMetadataJson,
      modelName: jobInfo.modelName,
      modelProvider: provider,
      modelSecretRef: jobInfo.modelSecretRef,
      modelVersion: jobInfo.modelVersion,
      providerConnectionId: null,
      providerMaxInflightRequests: null,
      providerUsesFamilyDefault: true,
      modelWorkerUrls: runtime.workerUrls,
    }
  })
}

const getOwnerBackedReadyRows = async (
  serverJobId: string,
  jobId: string,
  limit: number,
  protectedRecordIds: string[],
): Promise<PromptToProcess[]> => {
  const jobInfo = await getOwnerBackedJudgmentJobInfo(jobId)

  if (!jobInfo) {
    console.error('[getAndUpdateReadyPrompts] owner-backed job info not found for jobId:', jobId)
    return []
  }

  const runtime = getOwnerBackedPromptRuntime(jobId, jobInfo)

  if (!runtime) {
    return []
  }

  const claims = await claimOwnerJudgmentJobPrompts({claimedBy: serverJobId, jobId, limit, protectedRecordIds})
  const prompts = claims.map((prompt) => {
    return {
      ...prompt,
      maxInflightRequests: jobInfo.maxInflightRequests,
      modelBaseUrl: runtime.modelBaseUrl,
      modelId: jobInfo.modelId,
      modelMetadataJson: jobInfo.modelMetadataJson,
      modelName: jobInfo.modelName,
      modelProvider: runtime.modelProvider,
      modelSecretRef: jobInfo.modelSecretRef,
      modelVersion: jobInfo.modelVersion,
      providerConnectionId: jobInfo.providerId,
      providerFamily: jobInfo.providerFamily,
      providerId: jobInfo.providerId,
      providerKey: jobInfo.providerKey,
      providerLimit: jobInfo.providerLimit,
      providerLimitVersion: jobInfo.providerLimitVersion,
      providerMaxInflightRequests: jobInfo.providerLimit,
      providerName: jobInfo.providerName,
      providerUsesFamilyDefault: jobInfo.providerUsesFamilyDefault,
      resolvedDefaultCapacity: jobInfo.resolvedDefaultCapacity,
      modelWorkerUrls: runtime.modelWorkerUrls,
      projectId: jobInfo.projectId,
      useAbstract: jobInfo.useAbstract,
      useFulltext: jobInfo.useFulltext,
      useFulltextNoImages: jobInfo.useFulltextNoImages,
      useTitle: jobInfo.useTitle,
    }
  })

  await recordAcceptedJudgeWorkerClaims(prompts)

  return prompts
}

export const getReadyPromptRuntime = async (jobId: string): Promise<PromptRuntime | null> => {
  if (shouldUseJudgeWorkerOwnerHandoff()) {
    const jobInfo = await getOwnerBackedJudgmentJobInfo(jobId)

    if (!jobInfo) {
      console.error('[getReadyPromptRuntime] owner-backed job info not found for jobId:', jobId)
      return null
    }

    return getOwnerBackedPromptRuntime(jobId, jobInfo)
  }

  if (!(await isJobReadyToClaimPrompts(jobId))) {
    return null
  }

  const jobInfo = await getJudgmentJobSqliteService().getJobInfo(jobId)

  if (!jobInfo) {
    console.error('[getReadyPromptRuntime] SQLite job info not found for jobId:', jobId)
    return null
  }

  const provider = normalizeProvider(jobInfo.modelProvider)

  if (isCodexProvider(provider)) {
    return getCodexPromptRuntime()
  }

  const runtime = await getModelRuntime({
    baseURL: jobInfo.modelBaseUrl,
    modelName: jobInfo.modelName,
    providerConfigJson: jobInfo.providerConfigJson,
    providerKind: provider,
  })

  if (!isCodexProvider(provider) && !runtime.baseURL) {
    console.error('Prompt missing required matched model baseURL:', {
      jobId,
      modelName: jobInfo.modelName,
      modelProvider: jobInfo.modelProvider,
      runtimeMatchReason: runtime.reason,
      runtimeResolutionMode: runtime.resolutionMode,
      runtimeStatus: runtime.status,
    })
    return null
  }

  return {modelBaseUrl: String(runtime.baseURL), modelProvider: provider, modelWorkerUrls: runtime.workerUrls}
}

export const getAndUpdateReadyPrompts = async (
  serverJobId: string,
  jobId: string,
  limit: number,
  requestRuntime: {
    providerFamily?: string | null
    providerId?: string | null
    providerKey?: string | null
    providerConnectionId: string | null
    providerLimit?: number | null
    providerLimitVersion?: string | null
    providerMaxInflightRequests: number | null
    providerName?: string | null
    providerUsesFamilyDefault: boolean
    resolvedDefaultCapacity?: number | null
  },
  options: {protectedRecordIds?: string[]} = {},
): Promise<PromptToProcess[]> => {
  if (shouldUseJudgeWorkerOwnerHandoff()) {
    return getOwnerBackedReadyRows(serverJobId, jobId, limit, options.protectedRecordIds ?? [])
  }

  const prompts = await getSqliteReadyRows(serverJobId, jobId, limit)

  return prompts.map((prompt) => {
    return {...prompt, ...requestRuntime}
  })
}
