import {getProviderConnectionConfigFromJson} from '../../../providers/providerDbUtils.ts'
import {
  getProviderConnectionEffectiveBaseURL,
  getProviderConnectionWorkerState,
} from '../../../providers/providerRuntimeState.ts'
import {getAppDatabaseService} from '../../../services/appDatabaseService.ts'
import {escapeSqlString, getQuotedStringList, getSqlLiteral} from '../../../services/appQueryHelpers.ts'
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

type JobConfig = {
  modelId: string | null
  useTitle: boolean
  useAbstract: boolean
  useFulltext: boolean
  useFulltextNoImages: boolean
}

type ReadyRow = {id: string; articleId: string; promptId: string; jobId: string}

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

const getModelRuntime = ({
  baseURL,
  providerKind,
  providerConfigJson,
}: {
  baseURL: string | null
  providerKind: string
  providerConfigJson: unknown
}): {baseURL: string | null; workerUrls: string[]} => {
  const config = getProviderConnectionConfigFromJson({providerKind, value: providerConfigJson})
  const workerState = getProviderConnectionWorkerState({config, providerKind})

  return {
    baseURL: getProviderConnectionEffectiveBaseURL({baseURL, config, providerKind}),
    workerUrls: workerState.effectiveWorkerUrls,
  }
}

const processReadyRows = async (serverJobId: string, readyRows: ReadyRow[]): Promise<PromptToProcess[]> => {
  const readyIds = readyRows.map((r) => {
    return r.id
  })

  const now = new Date()
  const promptsWithJobs = await getAppDatabaseService().queryJson<{
    recordId: string
    articleId: string
    promptId: string
    jobId: string
  }>(`
    UPDATE app.judgment_job_prompt
    SET status = 'sent',
        sent_at = ${getSqlLiteral(now)},
        updated_at = ${getSqlLiteral(now)},
        server_id = ${getSqlLiteral(serverJobId)}
    WHERE status = 'ready'
      AND id IN (${getQuotedStringList(readyIds).join(', ')})
    RETURNING id AS recordId, article_id AS articleId, prompt_id AS promptId, job_id AS jobId
  `)

  const uniqueJobIds = [
    ...new Set(
      promptsWithJobs.map((prompt) => {
        return prompt.jobId
      }),
    ),
  ]

  const jobConfigs =
    uniqueJobIds.length === 0
      ? []
      : await getAppDatabaseService().queryJson<{
          jobId: string
          projectId: string | null
          modelId: string | null
          modelSecretRef: string | null
          modelProvider: string | null
          modelName: string | null
          modelVersion: string | null
          modelMetadataJson: unknown
          modelBaseUrl: string | null
          providerConfigJson: unknown
          useTitle: boolean | null
          useAbstract: boolean | null
          useFulltext: boolean | null
          useFulltextNoImages: boolean | null
        }>(`
          SELECT
            jj.id AS jobId,
            jj.project_id AS projectId,
            p.model_id AS modelId,
            pc.secret_ref AS modelSecretRef,
            pc.provider_kind AS modelProvider,
            m.remote_model_id AS modelName,
            m.variant AS modelVersion,
            TO_JSON(m.metadata_json) AS modelMetadataJson,
            pc.base_url AS modelBaseUrl,
            TO_JSON(pc.config_json) AS providerConfigJson,
            p.use_title AS useTitle,
            p.use_abstract AS useAbstract,
            p.use_fulltext AS useFulltext,
            p.use_fulltext_no_images AS useFulltextNoImages
          FROM app.judgment_job jj
          LEFT JOIN app.project p ON p.id = jj.project_id
          LEFT JOIN app.model m ON m.id = p.model_id
          INNER JOIN app.provider_connection pc ON pc.id = m.provider_connection_id
          WHERE jj.id IN (${getQuotedStringList(uniqueJobIds).join(', ')})
        `)

  const jobConfigPairs = jobConfigs.map((config) => {
    return [config.jobId, config] as const
  })
  const jobConfigMap = new Map(jobConfigPairs)

  const promptsWithProjects = promptsWithJobs
    .map((prompt) => {
      const config = jobConfigMap.get(prompt.jobId)
      if (!config?.projectId || !config?.modelId || !config?.modelName) {
        console.error('Prompt missing required model config:', {
          articleId: prompt.articleId,
          promptId: prompt.promptId,
          jobId: prompt.jobId,
          hasConfig: !!config,
          projectId: config?.projectId,
          modelId: config?.modelId,
          modelProvider: config?.modelProvider,
          modelName: config?.modelName,
          modelBaseUrl: config?.modelBaseUrl,
        })
        return null
      }

      const provider = normalizeProvider(config.modelProvider)
      const runtime = getModelRuntime({
        baseURL: config.modelBaseUrl,
        providerConfigJson: config.providerConfigJson,
        providerKind: provider,
      })
      if (!isCodexProvider(provider) && !runtime.baseURL) {
        console.error('Prompt missing required model baseURL:', {
          articleId: prompt.articleId,
          promptId: prompt.promptId,
          jobId: prompt.jobId,
          modelProvider: config.modelProvider,
          modelName: config.modelName,
        })
        return null
      }

      const baseUrl = isCodexProvider(provider) ? getCodexPlaceholderBaseUrl() : String(runtime.baseURL)

      return {
        ...prompt,
        projectId: config.projectId,
        modelId: config.modelId,
        modelMetadataJson: config.modelMetadataJson,
        modelProvider: provider,
        modelSecretRef: config.modelSecretRef ?? null,
        modelName: config.modelName,
        modelVersion: config.modelVersion ?? null,
        modelBaseUrl: baseUrl,
        modelWorkerUrls: runtime.workerUrls,
        useTitle: config.useTitle ?? true,
        useAbstract: config.useAbstract ?? true,
        useFulltext: config.useFulltext ?? false,
        useFulltextNoImages: config.useFulltextNoImages ?? false,
      }
    })
    .filter((prompt): prompt is PromptToProcess => {
      return prompt !== null
    })

  return promptsWithProjects
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
  const runtime = getModelRuntime({
    baseURL: jobInfo.modelBaseUrl,
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

const getReadyCandidateBatchSize = (limit: number): number => {
  return Math.min(2_000, Math.max(limit, limit * 5))
}

const getReadyRows = async ({
  excludedIds,
  jobId,
  limit,
}: {
  excludedIds: string[]
  jobId: string
  limit: number
}): Promise<ReadyRow[]> => {
  const excludedIdsClause =
    excludedIds.length === 0 ? '' : `AND jjp.id NOT IN (${getQuotedStringList(excludedIds).join(', ')})`

  return getAppDatabaseService().queryJson<ReadyRow>(`
    SELECT
      jjp.id AS id,
      jjp.article_id AS articleId,
      jjp.prompt_id AS promptId,
      jjp.job_id AS jobId
    FROM app.judgment_job_prompt jjp
    INNER JOIN app.article a ON a.id = jjp.article_id
    WHERE jjp.job_id = '${escapeSqlString(jobId)}'
      AND jjp.status = 'ready'
      ${excludedIdsClause}
    ORDER BY CASE WHEN COALESCE(a.full_text_char_count, 0) > 0 THEN 0 ELSE 1 END, jjp.created_at ASC
    LIMIT ${limit}
  `)
}

const getHasMatchingJudgment = async ({
  jobConfig,
  readyRow,
}: {
  jobConfig: JobConfig
  readyRow: ReadyRow
}): Promise<boolean> => {
  const rows = await getAppDatabaseService().queryJson<{id: string}>(`
    SELECT id
    FROM app.judgment
    WHERE article_id = ${getSqlLiteral(readyRow.articleId)}
      AND prompt_id = ${getSqlLiteral(readyRow.promptId)}
      AND model_id = ${getSqlLiteral(jobConfig.modelId)}
      AND use_title = ${getSqlLiteral(jobConfig.useTitle)}
      AND use_abstract = ${getSqlLiteral(jobConfig.useAbstract)}
      AND use_fulltext = ${getSqlLiteral(jobConfig.useFulltext)}
      AND use_fulltext_no_images = ${getSqlLiteral(jobConfig.useFulltextNoImages)}
      AND deleted_at IS NULL
    LIMIT 1
  `)

  return rows.length > 0
}

const getStaleReadyRowIdsBatch = async ({
  jobConfig,
  readyRows,
}: {
  jobConfig: JobConfig
  readyRows: ReadyRow[]
}): Promise<string[]> => {
  if (readyRows.length === 0) return []

  return Promise.all(
    readyRows.map(async (readyRow) => {
      return (await getHasMatchingJudgment({jobConfig, readyRow})) ? readyRow.id : null
    }),
  ).then((recordIds) => {
    return recordIds.filter((recordId): recordId is string => {
      return recordId !== null
    })
  })
}

const getStaleReadyRowIds = async ({
  jobConfig,
  readyRows,
}: {
  jobConfig: JobConfig
  readyRows: ReadyRow[]
}): Promise<string[]> => {
  const batchSize = 50
  const head = readyRows.slice(0, batchSize)
  const tail = readyRows.slice(batchSize)
  const headIds = await getStaleReadyRowIdsBatch({jobConfig, readyRows: head})

  return tail.length === 0 ? headIds : [...headIds, ...(await getStaleReadyRowIds({jobConfig, readyRows: tail}))]
}

const markReadyRowsJudged = async (recordIds: string[]): Promise<void> => {
  if (recordIds.length === 0) return

  await getAppDatabaseService().run(`
    UPDATE app.judgment_job_prompt
    SET status = 'judged',
        judged_at = current_timestamp,
        updated_at = current_timestamp
    WHERE id IN (${getQuotedStringList(recordIds).join(', ')})
  `)

  console.log(`[cleanup] Marked ${recordIds.length} stale queue entries as judged`)
}

const getClaimableReadyRows = async ({
  excludedIds = [],
  jobConfig,
  jobId,
  limit,
}: {
  excludedIds?: string[]
  jobConfig: JobConfig
  jobId: string
  limit: number
}): Promise<ReadyRow[]> => {
  const batchSize = getReadyCandidateBatchSize(limit)
  const readyRows = await getReadyRows({excludedIds, jobId, limit: batchSize})

  if (readyRows.length === 0) return []

  const staleIds = await getStaleReadyRowIds({jobConfig, readyRows})
  const staleIdSet = new Set(staleIds)

  if (staleIds.length > 0) {
    await markReadyRowsJudged(staleIds)
  }

  const claimableRows = readyRows.filter((readyRow) => {
    return !staleIdSet.has(readyRow.id)
  })

  return claimableRows.length >= limit || readyRows.length < batchSize
    ? claimableRows.slice(0, limit)
    : [
        ...claimableRows,
        ...(await getClaimableReadyRows({
          excludedIds: [
            ...excludedIds,
            ...readyRows.map((readyRow) => {
              return readyRow.id
            }),
          ],
          jobConfig,
          jobId,
          limit: limit - claimableRows.length,
        })),
      ]
}

export const getAndUpdateReadyPrompts = async (
  serverJobId: string,
  jobId: string,
  limit: number,
): Promise<PromptToProcess[]> => {
  const sqliteService = getJudgmentJobSqliteService()

  if (sqliteService.hasJob(jobId)) {
    return getSqliteReadyRows(serverJobId, jobId, limit)
  }

  const [jobConfig] = await getAppDatabaseService().queryJson<JobConfig>(`
    SELECT
      p.model_id AS modelId,
      p.use_title AS useTitle,
      p.use_abstract AS useAbstract,
      p.use_fulltext AS useFulltext,
      p.use_fulltext_no_images AS useFulltextNoImages
    FROM app.judgment_job jj
    INNER JOIN app.project p ON p.id = jj.project_id
    WHERE jj.id = '${escapeSqlString(jobId)}'
    LIMIT 1
  `)

  if (!jobConfig?.modelId) {
    console.error('[getAndUpdateReadyPrompts] Job config not found for jobId:', jobId)
    return []
  }

  const readyRows = await getClaimableReadyRows({jobConfig, jobId, limit})

  return readyRows.length === 0 ? [] : processReadyRows(serverJobId, readyRows)
}
