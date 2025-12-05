import {and, eq, inArray} from 'drizzle-orm'
import type {PostgresJsDatabase} from 'drizzle-orm/postgres-js'

import * as schema from '../../../../db/schema.ts'

export type PromptToProcess = {
  jobId: string
  articleId: string
  recordId: string
  projectId: string
  modelId: string
  modelName: string
  modelBaseUrl: string
}

const processReadyRows = async (
  db: PostgresJsDatabase<typeof schema>,
  serverJobId: string,
  readyRows: {id: string; articleId: string; jobId: string}[],
): Promise<PromptToProcess[]> => {
  const readyIds = readyRows.map((r) => {
    return r.id
  })

  const promptsWithJobs = await db
    .update(schema.judgmentsJobsArticles)
    .set({status: 'sent', sentAt: new Date(), updatedAt: new Date()})
    .where(
      and(eq(schema.judgmentsJobsArticles.serverId, serverJobId), inArray(schema.judgmentsJobsArticles.id, readyIds)),
    )
    .returning({
      recordId: schema.judgmentsJobsArticles.id,
      articleId: schema.judgmentsJobsArticles.articleId,
      jobId: schema.judgmentsJobsArticles.jobId,
    })

  const selectedMap = new Set(readyIds)
  const selectedPrompts = promptsWithJobs.filter((row) => {
    return selectedMap.has(row.recordId)
  })

  const uniqueJobIds = [
    ...new Set(
      selectedPrompts.map((prompt) => {
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
          })
          .from(schema.judgmentsJobs)
          .leftJoin(schema.projects, eq(schema.projects.id, schema.judgmentsJobs.projectId))
          .leftJoin(schema.models, eq(schema.models.id, schema.projects.modelId))
          .where(inArray(schema.judgmentsJobs.id, uniqueJobIds))

  const jobConfigPairs = jobConfigs.map((config) => {
    return [config.jobId, config] as const
  })
  const jobConfigMap = new Map(jobConfigPairs)

  const promptsWithProjects = selectedPrompts
    .map((prompt) => {
      const config = jobConfigMap.get(prompt.jobId)
      if (!config?.projectId || !config?.modelId || !config?.modelName || !config?.modelBaseUrl) {
        console.error('Prompt missing required model config:', {
          articleId: prompt.articleId,
          jobId: prompt.jobId,
          hasConfig: !!config,
          projectId: config?.projectId,
          modelId: config?.modelId,
          modelName: config?.modelName,
          modelBaseUrl: config?.modelBaseUrl,
        })
        return null
      }
      return {
        ...prompt,
        projectId: config.projectId,
        modelId: config.modelId,
        modelName: config.modelName,
        modelBaseUrl: config.modelBaseUrl,
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
  const readyRows = await db
    .select({
      id: schema.judgmentsJobsArticles.id,
      articleId: schema.judgmentsJobsArticles.articleId,
      jobId: schema.judgmentsJobsArticles.jobId,
    })
    .from(schema.judgmentsJobsArticles)
    .where(
      and(
        eq(schema.judgmentsJobsArticles.serverId, serverJobId),
        eq(schema.judgmentsJobsArticles.jobId, jobId),
        eq(schema.judgmentsJobsArticles.status, 'ready'),
      ),
    )
    .orderBy(schema.judgmentsJobsArticles.createdAt)
    .limit(limit)

  return readyRows.length === 0 ? [] : processReadyRows(db, serverJobId, readyRows)
}
