import {and, eq, inArray, isNull, sql} from 'drizzle-orm'

import * as schema from '../../../../db/schema.ts'
import type {AppDatabase} from '../../../utils/getDatabase.ts'

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
  db: AppDatabase,
  serverJobId: string,
  readyRows: {id: string; articleId: string; promptId: string; jobId: string}[],
): Promise<PromptToProcess[]> => {
  const readyIds = readyRows.map((r) => {
    return r.id
  })

  const now = new Date()
  const promptsWithJobs = await db
    .update(schema.judgmentsJobsPrompts)
    .set({status: 'sent', sentAt: now, updatedAt: now, serverId: serverJobId})
    .where(and(eq(schema.judgmentsJobsPrompts.status, 'ready'), inArray(schema.judgmentsJobsPrompts.id, readyIds)))
    .returning({
      recordId: schema.judgmentsJobsPrompts.id,
      articleId: schema.judgmentsJobsPrompts.articleId,
      promptId: schema.judgmentsJobsPrompts.promptId,
      jobId: schema.judgmentsJobsPrompts.jobId,
    })

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
      : await db
          .select({
            jobId: schema.judgmentsJobs.id,
            projectId: schema.judgmentsJobs.projectId,
            modelId: schema.projects.modelId,
            modelProvider: schema.models.provider,
            modelName: schema.models.modelName,
            modelVersion: schema.models.version,
            modelBaseUrl: schema.models.baseURL,
            useTitle: schema.projects.useTitle,
            useAbstract: schema.projects.useAbstract,
            useFulltext: schema.projects.useFulltext,
            useFulltextNoImages: schema.projects.useFulltextNoImages,
          })
          .from(schema.judgmentsJobs)
          .leftJoin(schema.projects, eq(schema.projects.id, schema.judgmentsJobs.projectId))
          .leftJoin(schema.models, eq(schema.models.id, schema.projects.modelId))
          .where(inArray(schema.judgmentsJobs.id, uniqueJobIds))

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
  db: AppDatabase,
  serverJobId: string,
  jobId: string,
  limit: number,
): Promise<PromptToProcess[]> => {
  // Get job config to know content settings for judgment matching
  const [jobConfig] = await db
    .select({
      modelId: schema.projects.modelId,
      useTitle: schema.projects.useTitle,
      useAbstract: schema.projects.useAbstract,
      useFulltext: schema.projects.useFulltext,
      useFulltextNoImages: schema.projects.useFulltextNoImages,
    })
    .from(schema.judgmentsJobs)
    .innerJoin(schema.projects, eq(schema.projects.id, schema.judgmentsJobs.projectId))
    .where(eq(schema.judgmentsJobs.id, jobId))
    .limit(1)

  if (!jobConfig?.modelId) {
    console.error('[getAndUpdateReadyPrompts] Job config not found for jobId:', jobId)
    return []
  }

  // Fetch ready prompts, excluding those that already have judgments
  // This prevents wasting capacity on stale queue entries from ClickHouse replication lag
  const readyRows = await db
    .select({
      id: schema.judgmentsJobsPrompts.id,
      articleId: schema.judgmentsJobsPrompts.articleId,
      promptId: schema.judgmentsJobsPrompts.promptId,
      jobId: schema.judgmentsJobsPrompts.jobId,
    })
    .from(schema.judgmentsJobsPrompts)
    .innerJoin(schema.articles, eq(schema.articles.id, schema.judgmentsJobsPrompts.articleId))
    .leftJoin(
      schema.judgments,
      and(
        eq(schema.judgments.articleId, schema.judgmentsJobsPrompts.articleId),
        eq(schema.judgments.promptId, schema.judgmentsJobsPrompts.promptId),
        eq(schema.judgments.modelId, jobConfig.modelId),
        eq(schema.judgments.useTitle, jobConfig.useTitle),
        eq(schema.judgments.useAbstract, jobConfig.useAbstract),
        eq(schema.judgments.useFulltext, jobConfig.useFulltext),
        eq(schema.judgments.useFulltextNoImages, jobConfig.useFulltextNoImages),
        isNull(schema.judgments.deletedAt),
      ),
    )
    .where(
      and(
        eq(schema.judgmentsJobsPrompts.jobId, jobId),
        eq(schema.judgmentsJobsPrompts.status, 'ready'),
        isNull(schema.judgments.id), // No existing judgment
      ),
    )
    // Order by: articles with fullText first (DESC puts non-null first), then by createdAt
    .orderBy(
      sql`CASE WHEN ${schema.articles.fullText} IS NOT NULL THEN 0 ELSE 1 END`,
      schema.judgmentsJobsPrompts.createdAt,
    )
    .limit(limit)

  // If we found fewer than requested, clean up stale entries that already have judgments
  // This happens due to ClickHouse replication lag - prompts get queued but are already judged
  if (readyRows.length < limit) {
    const staleCleanupLimit = Math.min(500, limit * 2) // Clean up more aggressively
    const staleRows = await db
      .select({id: schema.judgmentsJobsPrompts.id})
      .from(schema.judgmentsJobsPrompts)
      .innerJoin(
        schema.judgments,
        and(
          eq(schema.judgments.articleId, schema.judgmentsJobsPrompts.articleId),
          eq(schema.judgments.promptId, schema.judgmentsJobsPrompts.promptId),
          eq(schema.judgments.modelId, jobConfig.modelId),
          eq(schema.judgments.useTitle, jobConfig.useTitle),
          eq(schema.judgments.useAbstract, jobConfig.useAbstract),
          eq(schema.judgments.useFulltext, jobConfig.useFulltext),
          eq(schema.judgments.useFulltextNoImages, jobConfig.useFulltextNoImages),
          isNull(schema.judgments.deletedAt),
        ),
      )
      .where(and(eq(schema.judgmentsJobsPrompts.jobId, jobId), eq(schema.judgmentsJobsPrompts.status, 'ready')))
      .limit(staleCleanupLimit)

    if (staleRows.length > 0) {
      const staleIds = staleRows.map((r) => {
        return r.id
      })
      await db
        .update(schema.judgmentsJobsPrompts)
        .set({status: 'judged', judgedAt: new Date(), updatedAt: new Date()})
        .where(inArray(schema.judgmentsJobsPrompts.id, staleIds))
      console.log(`[cleanup] Marked ${staleRows.length} stale queue entries as judged`)
    }
  }

  return readyRows.length === 0 ? [] : processReadyRows(db, serverJobId, readyRows)
}
