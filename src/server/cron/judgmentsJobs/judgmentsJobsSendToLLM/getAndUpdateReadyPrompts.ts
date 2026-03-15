import {getAppDatabaseService} from '../../../services/appDatabaseService.ts'
import {escapeSqlString, getQuotedStringList, getSqlLiteral} from '../../../services/appQueryHelpers.ts'

export type PromptToProcess = {
  jobId: string
  articleId: string
  promptId: string
  recordId: string
  projectId: string
  modelId: string
  modelProvider: string
  modelName: string
  modelVersion: string | null
  modelBaseUrl: string
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

const processReadyRows = async (
  serverJobId: string,
  readyRows: {id: string; articleId: string; promptId: string; jobId: string}[],
): Promise<PromptToProcess[]> => {
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
          modelProvider: string | null
          modelName: string | null
          modelVersion: string | null
          modelBaseUrl: string | null
          useTitle: boolean | null
          useAbstract: boolean | null
          useFulltext: boolean | null
          useFulltextNoImages: boolean | null
        }>(`
          SELECT
            jj.id AS jobId,
            jj.project_id AS projectId,
            p.model_id AS modelId,
            m.provider AS modelProvider,
            m.model_name AS modelName,
            m.version AS modelVersion,
            m.base_url AS modelBaseUrl,
            p.use_title AS useTitle,
            p.use_abstract AS useAbstract,
            p.use_fulltext AS useFulltext,
            p.use_fulltext_no_images AS useFulltextNoImages
          FROM app.judgment_job jj
          LEFT JOIN app.project p ON p.id = jj.project_id
          LEFT JOIN app.model m ON m.id = p.model_id
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
      if (!isCodexProvider(provider) && !config.modelBaseUrl) {
        console.error('Prompt missing required model baseURL:', {
          articleId: prompt.articleId,
          promptId: prompt.promptId,
          jobId: prompt.jobId,
          modelProvider: config.modelProvider,
          modelName: config.modelName,
        })
        return null
      }

      const baseUrl = isCodexProvider(provider) ? getCodexPlaceholderBaseUrl() : String(config.modelBaseUrl)

      return {
        ...prompt,
        projectId: config.projectId,
        modelId: config.modelId,
        modelProvider: provider,
        modelName: config.modelName,
        modelVersion: config.modelVersion ?? null,
        modelBaseUrl: baseUrl,
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

export const getAndUpdateReadyPrompts = async (
  serverJobId: string,
  jobId: string,
  limit: number,
): Promise<PromptToProcess[]> => {
  // Get job config to know content settings for judgment matching
  const [jobConfig] = await getAppDatabaseService().queryJson<{
    modelId: string | null
    useTitle: boolean
    useAbstract: boolean
    useFulltext: boolean
    useFulltextNoImages: boolean
  }>(`
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

  // Fetch ready prompts, excluding those that already have judgments.
  // This prevents wasting capacity on stale queue entries.
  const readyRows = await getAppDatabaseService().queryJson<{
    id: string
    articleId: string
    promptId: string
    jobId: string
  }>(`
    SELECT
      jjp.id AS id,
      jjp.article_id AS articleId,
      jjp.prompt_id AS promptId,
      jjp.job_id AS jobId
    FROM app.judgment_job_prompt jjp
    INNER JOIN app.article a ON a.id = jjp.article_id
    LEFT JOIN app.judgment j ON
      j.article_id = jjp.article_id
      AND j.prompt_id = jjp.prompt_id
      AND j.model_id = ${getSqlLiteral(jobConfig.modelId)}
      AND j.use_title = ${getSqlLiteral(jobConfig.useTitle)}
      AND j.use_abstract = ${getSqlLiteral(jobConfig.useAbstract)}
      AND j.use_fulltext = ${getSqlLiteral(jobConfig.useFulltext)}
      AND j.use_fulltext_no_images = ${getSqlLiteral(jobConfig.useFulltextNoImages)}
      AND j.deleted_at IS NULL
    WHERE jjp.job_id = '${escapeSqlString(jobId)}'
      AND jjp.status = 'ready'
      AND j.id IS NULL
    ORDER BY CASE WHEN a.full_text IS NOT NULL THEN 0 ELSE 1 END, jjp.created_at ASC
    LIMIT ${limit}
  `)

  // If we found fewer than requested, clean up stale entries that already have judgments.
  if (readyRows.length < limit) {
    const staleCleanupLimit = Math.min(500, limit * 2) // Clean up more aggressively
    const staleRows = await getAppDatabaseService().queryJson<{id: string}>(`
      SELECT jjp.id AS id
      FROM app.judgment_job_prompt jjp
      INNER JOIN app.judgment j ON
        j.article_id = jjp.article_id
        AND j.prompt_id = jjp.prompt_id
        AND j.model_id = ${getSqlLiteral(jobConfig.modelId)}
        AND j.use_title = ${getSqlLiteral(jobConfig.useTitle)}
        AND j.use_abstract = ${getSqlLiteral(jobConfig.useAbstract)}
        AND j.use_fulltext = ${getSqlLiteral(jobConfig.useFulltext)}
        AND j.use_fulltext_no_images = ${getSqlLiteral(jobConfig.useFulltextNoImages)}
        AND j.deleted_at IS NULL
      WHERE jjp.job_id = '${escapeSqlString(jobId)}'
        AND jjp.status = 'ready'
      LIMIT ${staleCleanupLimit}
    `)

    if (staleRows.length > 0) {
      const staleIds = staleRows.map((r) => {
        return r.id
      })
      await getAppDatabaseService().run(`
        UPDATE app.judgment_job_prompt
        SET status = 'judged',
            judged_at = current_timestamp,
            updated_at = current_timestamp
        WHERE id IN (${getQuotedStringList(staleIds).join(', ')})
      `)
      console.log(`[cleanup] Marked ${staleRows.length} stale queue entries as judged`)
    }
  }

  return readyRows.length === 0 ? [] : processReadyRows(serverJobId, readyRows)
}
