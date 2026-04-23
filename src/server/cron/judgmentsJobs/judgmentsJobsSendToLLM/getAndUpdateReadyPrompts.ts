import {getProviderConnectionConfigFromJson} from '../../../providers/providerDbUtils.ts'
import {resolveProviderConnectionRuntimeMatch} from '../../../providers/providerRuntimeMatchResolver.ts'
import {getSqlLiteral} from '../../../services/appQueryHelpers.ts'
import {getJudgeWorkerReadOnlyAppDatabaseService} from '../../../services/appReadOnlyDatabaseService.ts'
import {
  claimOwnerJudgmentJobPrompts,
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
  modelId: string
  modelMetadataJson: unknown
  modelProvider: string
  modelSecretRef: string | null
  modelName: string
  modelVersion: string | null
  modelBaseUrl: string
  providerConnectionId: string | null
  providerMaxInflightRequests: number | null
  providerUsesFamilyDefault: boolean
  modelWorkerUrls: string[]
  useTitle: boolean
  useAbstract: boolean
  useFulltext: boolean
  useFulltextNoImages: boolean
}

export type PromptRuntime = {modelBaseUrl: string; modelProvider: string; modelWorkerUrls: string[]}

type OwnerBackedJobInfo = {
  modelBaseUrl: string | null
  modelId: string
  modelMetadataJson: unknown
  modelName: string
  modelProvider: string
  modelSecretRef: string | null
  modelVersion: string | null
  projectId: string
  providerConfigJson: unknown
  useAbstract: boolean
  useFulltext: boolean
  useFulltextNoImages: boolean
  useTitle: boolean
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

const parseJsonText = (value: unknown): unknown => {
  if (value == null) {
    return null
  }

  if (typeof value !== 'string') {
    return value
  }

  try {
    return JSON.parse(value) as unknown
  } catch {
    return value
  }
}

const getOwnerBackedJobInfo = async (jobId: string): Promise<OwnerBackedJobInfo | null> => {
  const [row] = await getJudgeWorkerReadOnlyAppDatabaseService().queryJson<{
    modelBaseUrl: string | null
    modelId: string | null
    modelMetadataJson: unknown
    modelName: string | null
    modelProvider: string | null
    modelSecretRef: string | null
    modelVersion: string | null
    projectId: string | null
    providerConfigJson: unknown
    useAbstract: boolean | null
    useFulltext: boolean | null
    useFulltextNoImages: boolean | null
    useTitle: boolean | null
  }>(`
    SELECT
      jj.project_id AS projectId,
      p.model_id AS modelId,
      pc.secret_ref AS modelSecretRef,
      COALESCE(pc.provider_kind, 'unknown') AS modelProvider,
      COALESCE(m.remote_model_id, m.name, m.display_name) AS modelName,
      m.variant AS modelVersion,
      TO_JSON(m.metadata_json) AS modelMetadataJson,
      pc.base_url AS modelBaseUrl,
      TO_JSON(pc.config_json) AS providerConfigJson,
      p.use_title AS useTitle,
      p.use_abstract AS useAbstract,
      p.use_fulltext AS useFulltext,
      p.use_fulltext_no_images AS useFulltextNoImages
    FROM app.judgment_job jj
    INNER JOIN app.project p ON p.id = jj.project_id
    INNER JOIN app.model m ON m.id = p.model_id
    LEFT JOIN app.provider_connection pc ON pc.id = m.provider_connection_id
    WHERE jj.id = ${getSqlLiteral(jobId)}
      AND jj.status = 'running'
      AND jj.storage_state = 'active'
    LIMIT 1
  `)

  return row?.projectId && row.modelId && row.modelName
    ? {
        modelBaseUrl: row.modelBaseUrl ?? null,
        modelId: row.modelId,
        modelMetadataJson: parseJsonText(row.modelMetadataJson),
        modelName: row.modelName,
        modelProvider: row.modelProvider ?? 'unknown',
        modelSecretRef: row.modelSecretRef ?? null,
        modelVersion: row.modelVersion ?? null,
        projectId: row.projectId,
        providerConfigJson: parseJsonText(row.providerConfigJson),
        useAbstract: row.useAbstract ?? true,
        useFulltext: row.useFulltext ?? false,
        useFulltextNoImages: row.useFulltextNoImages ?? false,
        useTitle: row.useTitle ?? true,
      }
    : null
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
  const baseUrl = isCodexProvider(provider) ? getCodexPlaceholderBaseUrl() : String(runtime.baseURL)

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
): Promise<PromptToProcess[]> => {
  if (!(await isJobReadyToClaimPrompts(jobId))) {
    return []
  }

  const jobInfo = await getOwnerBackedJobInfo(jobId)

  if (!jobInfo) {
    console.error('[getAndUpdateReadyPrompts] owner-backed job info not found for jobId:', jobId)
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

  const claims = await claimOwnerJudgmentJobPrompts({claimedBy: serverJobId, jobId, limit})
  const baseUrl = isCodexProvider(provider) ? getCodexPlaceholderBaseUrl() : String(runtime.baseURL)
  const prompts = claims.map((prompt) => {
    return {
      ...prompt,
      modelBaseUrl: baseUrl,
      modelId: jobInfo.modelId,
      modelMetadataJson: jobInfo.modelMetadataJson,
      modelName: jobInfo.modelName,
      modelProvider: provider,
      modelSecretRef: jobInfo.modelSecretRef,
      modelVersion: jobInfo.modelVersion,
      providerConnectionId: null,
      providerMaxInflightRequests: null,
      providerUsesFamilyDefault: true,
      modelWorkerUrls: runtime.workerUrls,
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
  if (!(await isJobReadyToClaimPrompts(jobId))) {
    return null
  }

  const sqliteService = getJudgmentJobSqliteService()
  const jobInfo = shouldUseJudgeWorkerOwnerHandoff()
    ? await getOwnerBackedJobInfo(jobId)
    : await sqliteService.getJobInfo(jobId)

  if (!jobInfo) {
    console.error('[getReadyPromptRuntime] SQLite job info not found for jobId:', jobId)
    return null
  }

  const provider = normalizeProvider(jobInfo.modelProvider)
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

  return {
    modelBaseUrl: isCodexProvider(provider) ? getCodexPlaceholderBaseUrl() : String(runtime.baseURL),
    modelProvider: provider,
    modelWorkerUrls: runtime.workerUrls,
  }
}

export const getAndUpdateReadyPrompts = async (
  serverJobId: string,
  jobId: string,
  limit: number,
  requestRuntime: {
    providerConnectionId: string | null
    providerMaxInflightRequests: number | null
    providerUsesFamilyDefault: boolean
  },
): Promise<PromptToProcess[]> => {
  const prompts = shouldUseJudgeWorkerOwnerHandoff()
    ? await getOwnerBackedReadyRows(serverJobId, jobId, limit)
    : await getSqliteReadyRows(serverJobId, jobId, limit)

  return prompts.map((prompt) => {
    return {...prompt, ...requestRuntime}
  })
}
