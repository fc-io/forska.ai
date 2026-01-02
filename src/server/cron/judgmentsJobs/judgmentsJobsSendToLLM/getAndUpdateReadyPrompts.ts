import {and, eq, inArray} from 'drizzle-orm'
import type {PostgresJsDatabase} from 'drizzle-orm/postgres-js'

import * as schema from '../../../../db/schema.ts'

export type PromptToProcess = {
  jobId: string
  articleId: string
  promptId: string
  recordId: string
  projectId: string
  modelId: string
  modelName: string
  modelBaseUrl: string
}

const processReadyRows = async (
  db: PostgresJsDatabase<typeof schema>,
  serverJobId: string,
  readyRows: {id: string; articleId: string; promptId: string; jobId: string}[],
): Promise<PromptToProcess[]> => {
  const readyIds = readyRows.map((r) => {
    return r.id
  })

  const promptsWithJobs = await db
    .update(schema.judgmentsJobsPrompts)
    .set({status: 'sent', sentAt: new Date(), updatedAt: new Date()})
    .where(
      and(eq(schema.judgmentsJobsPrompts.serverId, serverJobId), inArray(schema.judgmentsJobsPrompts.id, readyIds)),
    )
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
          })
          .from(schema.judgmentsJobs)
          .leftJoin(schema.projects, eq(schema.projects.id, schema.judgmentsJobs.projectId))
          .leftJoin(schema.models, eq(schema.models.id, schema.projects.modelId))
          .where(inArray(schema.judgmentsJobs.id, uniqueJobIds))

  const jobConfigPairs = jobConfigs.map((config) => {
    return [config.jobId, config] as const
  })
  const jobConfigMap = new Map(jobConfigPairs)

  // Get worker URLs from env for direct-to-worker mode (bypasses router)
  const workerUrlsEnv = process.env.WORKER_URLS
  const workerUrls = workerUrlsEnv ? workerUrlsEnv.split(',').map(u => u.trim()).filter(Boolean) : []
  const useDirectWorkers = workerUrls.length > 0

  // Random worker selection for load distribution across SSH tunnels
  const getRandomWorkerUrl = (): string => {
    return workerUrls[Math.floor(Math.random() * workerUrls.length)]
  }

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
      const baseUrl = useDirectWorkers
        ? `${getRandomWorkerUrl()}/v1`
        : config.modelBaseUrl

      return {
        ...prompt,
        projectId: config.projectId,
        modelId: config.modelId,
        modelName: config.modelName,
        modelBaseUrl: baseUrl,
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
      id: schema.judgmentsJobsPrompts.id,
      articleId: schema.judgmentsJobsPrompts.articleId,
      promptId: schema.judgmentsJobsPrompts.promptId,
      jobId: schema.judgmentsJobsPrompts.jobId,
    })
    .from(schema.judgmentsJobsPrompts)
    .where(
      and(
        eq(schema.judgmentsJobsPrompts.serverId, serverJobId),
        eq(schema.judgmentsJobsPrompts.jobId, jobId),
        eq(schema.judgmentsJobsPrompts.status, 'ready'),
      ),
    )
    .orderBy(schema.judgmentsJobsPrompts.createdAt)
    .limit(limit)

  return readyRows.length === 0 ? [] : processReadyRows(db, serverJobId, readyRows)
}
