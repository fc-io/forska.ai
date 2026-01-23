import {and, eq, inArray, isNull, sql} from 'drizzle-orm'
import type {PostgresJsDatabase} from 'drizzle-orm/postgres-js'

import * as schema from '../../../../db/schema.ts'
import {workerLoadBalancer} from '../../../utils/workerLoadBalancer.ts'

export type PromptToProcess = {
  jobId: string
  articleId: string
  promptId: string
  recordId: string
  projectId: string
  modelId: string
  modelName: string
  modelBaseUrl: string
  useTitle: boolean
  useAbstract: boolean
  useFulltext: boolean
  useFulltextNoImages: boolean
}

const processReadyRows = async (
  db: PostgresJsDatabase<typeof schema>,
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
            modelName: schema.models.modelName,
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

  // Use load balancer to get worker URL
  // This helps distribute load better than random selection
  // and keeps track of active connections per worker

  const promptsWithProjects = promptsWithJobs
    .map((prompt) => {
      const config = jobConfigMap.get(prompt.jobId)
      if (!config?.projectId || !config?.modelId || !config?.modelName || !config?.modelBaseUrl) {
        console.error('Prompt missing required model config:', {
          articleId: prompt.articleId,
          promptId: prompt.promptId,
          jobId: prompt.jobId,
          hasConfig: !!config,
          projectId: config?.projectId,
          modelId: config?.modelId,
          modelName: config?.modelName,
          modelBaseUrl: config?.modelBaseUrl,
        })
        return null
      }

      // Use random worker URL if direct-to-worker mode enabled, otherwise use DB config
      let baseUrl = config.modelBaseUrl
      const lbWorker = workerLoadBalancer.getWorkerUrl()
      if (lbWorker) {
        baseUrl = `${lbWorker}/v1`
      }

      return {
        ...prompt,
        projectId: config.projectId,
        modelId: config.modelId,
        modelName: config.modelName,
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
  db: PostgresJsDatabase<typeof schema>,
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

  return readyRows.length === 0 ? [] : processReadyRows(db, serverJobId, readyRows)
}
