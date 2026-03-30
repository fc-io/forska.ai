import {getProviderConnectionConfigFromJson} from '../../../providers/providerDbUtils.ts'
import {resolveProviderConnectionRuntimeMatch} from '../../../providers/providerRuntimeMatchResolver.ts'
import {getJudgmentJobSqliteService, JudgmentJobLeaseError} from '../judgmentJobSqliteService.ts'

export type PromptToProcess = {
  jobId: string
  articleId: string
  promptId: string
  recordId: string
  projectId: string
  modelId: string
  modelMetadataJson: unknown
  modelProvider: string
  modelSecretRef: string | null
  modelName: string
  modelVersion: string | null
  modelBaseUrl: string
  modelWorkerUrls: string[]
  useTitle: boolean
  useAbstract: boolean
  useFulltext: boolean
  useFulltextNoImages: boolean
}

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
}): Promise<{baseURL: string | null; workerUrls: string[]}> => {
  const config = getProviderConnectionConfigFromJson({providerKind, value: providerConfigJson})
  const runtimeMatch = await resolveProviderConnectionRuntimeMatch({
    baseURL,
    config,
    providerKind,
    savedModelIds: modelName ? [modelName] : [],
  })

  return {baseURL: runtimeMatch.effectiveBaseURL, workerUrls: runtimeMatch.effectiveWorkerUrls}
}

const getSqliteReadyRows = async (serverJobId: string, jobId: string, limit: number): Promise<PromptToProcess[]> => {
  const sqliteService = getJudgmentJobSqliteService()

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
  const runtime = await getModelRuntime({
    baseURL: jobInfo.modelBaseUrl,
    modelName: jobInfo.modelName,
    providerConfigJson: jobInfo.providerConfigJson,
    providerKind: provider,
  })

  if (!isCodexProvider(provider) && !runtime.baseURL) {
    console.error('Prompt missing required model baseURL:', {
      jobId,
      modelName: jobInfo.modelName,
      modelProvider: jobInfo.modelProvider,
    })
    return []
  }

  const claimedRows = await sqliteService.claimReadyPrompts(jobId, serverJobId, limit)
  const baseUrl = isCodexProvider(provider) ? getCodexPlaceholderBaseUrl() : String(runtime.baseURL)

  return claimedRows.map((prompt) => {
    return {
      ...prompt,
      modelBaseUrl: baseUrl,
      modelId: jobInfo.modelId,
      modelMetadataJson: jobInfo.modelMetadataJson,
      modelName: jobInfo.modelName,
      modelProvider: provider,
      modelSecretRef: jobInfo.modelSecretRef,
      modelVersion: jobInfo.modelVersion,
      modelWorkerUrls: runtime.workerUrls,
      projectId: jobInfo.projectId,
      useAbstract: jobInfo.useAbstract,
      useFulltext: jobInfo.useFulltext,
      useFulltextNoImages: jobInfo.useFulltextNoImages,
      useTitle: jobInfo.useTitle,
    }
  })
}

export const getAndUpdateReadyPrompts = async (
  serverJobId: string,
  jobId: string,
  limit: number,
): Promise<PromptToProcess[]> => {
  return getSqliteReadyRows(serverJobId, jobId, limit)
}
