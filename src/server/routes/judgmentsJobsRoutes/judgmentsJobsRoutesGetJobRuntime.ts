import {getSystemPromptVariant} from '../../../agent/judge/systemPromptVariant.ts'
import type {OwnerBackedJudgmentJobInfo} from '../../cron/judgmentsJobs/judgeWorkerCompletionJournal.ts'
import {getJudgmentJobSqliteService} from '../../cron/judgmentsJobs/judgmentJobSqliteService.ts'
import {
  getProviderBucketSnapshot,
  type ProviderBucketSnapshot,
} from '../../cron/judgmentsJobs/providerAdmissionLease.ts'
import {getProjectFullTextStrategyIdSql} from '../../fullText/fullTextStrategy.ts'
import {getProviderConnectionConfigFromJson} from '../../providers/providerDbUtils.ts'
import {resolveProviderConnectionRuntimeMatch} from '../../providers/providerRuntimeMatchResolver.ts'
import {getAppDatabaseService} from '../../services/appDatabaseService.ts'
import {getJsonValue, getSqlLiteral} from '../../services/appQueryHelpers.ts'
import {runJudgmentJobsRead} from './runJudgmentJobsRead.ts'

type OwnerBackedRuntimeResolution = Pick<
  OwnerBackedJudgmentJobInfo,
  'resolvedRuntime' | 'runtimeMatchReason' | 'runtimeMatchStatus' | 'runtimeResolutionMode'
>
type OwnerBackedProviderSnapshot = ProviderBucketSnapshot

const normalizeOwnerBackedProvider = (value: string | null | undefined): string => {
  const normalized = String(value ?? '')
    .trim()
    .toLowerCase()

  return normalized.length > 0 ? normalized : 'unknown'
}

const getCodexOwnerBackedRuntime = (): OwnerBackedRuntimeResolution => {
  return {
    resolvedRuntime: {modelBaseUrl: 'codex://app-server', modelProvider: 'codex', modelWorkerUrls: []},
    runtimeMatchReason: 'manual-provider',
    runtimeMatchStatus: 'matched',
    runtimeResolutionMode: 'manual',
  }
}

const getClaudeCodeOwnerBackedRuntime = (): OwnerBackedRuntimeResolution => {
  return {
    resolvedRuntime: {modelBaseUrl: 'claude-code://cli', modelProvider: 'claude-code', modelWorkerUrls: []},
    runtimeMatchReason: 'manual-provider',
    runtimeMatchStatus: 'matched',
    runtimeResolutionMode: 'manual',
  }
}

const getOwnerBackedRuntimeMatch = async ({
  baseURL,
  modelName,
  providerConfigJson,
  providerKind,
}: {
  baseURL: string | null
  modelName: string
  providerConfigJson: unknown
  providerKind: string
}): Promise<OwnerBackedRuntimeResolution> => {
  if (providerKind === 'codex') {
    return getCodexOwnerBackedRuntime()
  }

  if (providerKind === 'claude-code') {
    return getClaudeCodeOwnerBackedRuntime()
  }

  const config = getProviderConnectionConfigFromJson({providerKind, value: providerConfigJson})
  const runtimeMatch = await resolveProviderConnectionRuntimeMatch({
    baseURL,
    config,
    providerKind,
    savedModelIds: [modelName],
  })
  const shouldUseMatchedRuntime = runtimeMatch.resolutionMode === 'manual' || runtimeMatch.status === 'matched'
  const resolvedRuntime =
    shouldUseMatchedRuntime && runtimeMatch.effectiveBaseURL
      ? {
          modelBaseUrl: runtimeMatch.effectiveBaseURL,
          modelProvider: providerKind,
          modelWorkerUrls: runtimeMatch.effectiveWorkerUrls,
        }
      : null

  return {
    resolvedRuntime,
    runtimeMatchReason: runtimeMatch.reason,
    runtimeMatchStatus: runtimeMatch.status,
    runtimeResolutionMode: runtimeMatch.resolutionMode,
  }
}

const getOwnerBackedJudgmentJobRuntime = async (jobId: string): Promise<OwnerBackedJudgmentJobInfo | null> => {
  const [row] = await getAppDatabaseService().queryJson<{
    maxInflightRequests: number | null
    modelBaseUrl: string | null
    modelId: string | null
    modelMetadataJson: unknown
    modelName: string | null
    modelProvider: string | null
    modelSecretRef: string | null
    modelVersion: string | null
    projectId: string | null
    providerConfigJson: unknown
    providerConnectionId: string | null
    providerConnectionUpdatedAt: Date | string | null
    providerName: string | null
    systemPromptVariant: string | null
    fullTextStrategyId: string
    useAbstract: boolean | null
    useFulltext: boolean | null
    useFulltextNoImages: boolean | null
    useMetadata: boolean | null
    useTitle: boolean | null
  }>(`
    SELECT
      jj.project_id AS projectId,
      p.model_id AS modelId,
      pc.id AS providerConnectionId,
      pc.secret_ref AS modelSecretRef,
      COALESCE(pc.provider_kind, 'unknown') AS modelProvider,
      pc.label AS providerName,
      COALESCE(m.remote_model_id, m.name, m.display_name) AS modelName,
      m.variant AS modelVersion,
      TO_JSON(m.metadata_json) AS modelMetadataJson,
      pc.base_url AS modelBaseUrl,
      pc.max_inflight_requests AS maxInflightRequests,
      pc.updated_at AS providerConnectionUpdatedAt,
      TO_JSON(pc.config_json) AS providerConfigJson,
      p.system_prompt_variant AS systemPromptVariant,
      COALESCE(jj.full_text_strategy_id, ${getProjectFullTextStrategyIdSql('p')}) AS fullTextStrategyId,
      p.use_title AS useTitle,
      p.use_abstract AS useAbstract,
      p.use_fulltext AS useFulltext,
      p.use_fulltext_no_images AS useFulltextNoImages,
      COALESCE(p.use_metadata, FALSE) AS useMetadata
    FROM app.judgment_job jj
    INNER JOIN app.project p ON p.id = jj.project_id
    INNER JOIN app.model m ON m.id = p.model_id
    LEFT JOIN app.provider_connection pc ON pc.id = m.provider_connection_id
    WHERE jj.id = ${getSqlLiteral(jobId)}
      AND jj.status = 'running'
      AND jj.storage_state = 'active'
      AND p.archived = FALSE
      AND COALESCE(m.enabled, TRUE) = TRUE
      AND COALESCE(pc.enabled, TRUE) = TRUE
    LIMIT 1
  `)

  if (!row?.projectId || !row.modelId || !row.modelName) {
    return null
  }

  const providerKind = normalizeOwnerBackedProvider(row.modelProvider)
  const providerConfigJson = getJsonValue(row.providerConfigJson)
  const jobInfo = await getJudgmentJobSqliteService().getJobInfo(jobId)
  const providerSnapshot: OwnerBackedProviderSnapshot = getProviderBucketSnapshot({
    maxInflightRequests: row.maxInflightRequests ?? null,
    modelId: row.modelId,
    modelProvider: providerKind,
    providerConnectionId: row.providerConnectionId ?? null,
    providerConnectionUpdatedAt: row.providerConnectionUpdatedAt,
    providerName: row.providerName ?? row.modelName,
    useOwnerBackedSyntheticProviderId: true,
  })
  const runtimeMatch = await getOwnerBackedRuntimeMatch({
    baseURL: row.modelBaseUrl ?? null,
    modelName: row.modelName,
    providerConfigJson,
    providerKind,
  })

  return {
    fullTextStrategyId: jobInfo?.fullTextStrategyId ?? row.fullTextStrategyId,
    modelBaseUrl: row.modelBaseUrl ?? null,
    modelId: row.modelId,
    modelMetadataJson: getJsonValue(row.modelMetadataJson),
    modelName: row.modelName,
    modelProvider: providerKind,
    modelSecretRef: row.modelSecretRef ?? null,
    modelVersion: row.modelVersion ?? null,
    projectId: row.projectId,
    ...providerSnapshot,
    providerConfigJson,
    ...runtimeMatch,
    systemPromptVariant: jobInfo?.systemPromptVariant ?? getSystemPromptVariant(row.systemPromptVariant),
    useAbstract: row.useAbstract ?? true,
    useFulltext: row.useFulltext ?? false,
    useFulltextNoImages: row.useFulltextNoImages ?? false,
    useMetadata: jobInfo?.useMetadata ?? row.useMetadata ?? false,
    useTitle: row.useTitle ?? true,
  }
}

export const judgmentsJobsRoutesGetJobRuntime = async ({params, request}: {params: {id: string}; request: Request}) => {
  return runJudgmentJobsRead({
    operation: async () => {
      return {data: {job: await getOwnerBackedJudgmentJobRuntime(params.id)}, error: null}
    },
    request,
  })
}
