import {randomUUID} from 'node:crypto'

import {Elysia, t} from 'elysia'

import {
  assertArticleIdOnlyBulkOperationCaps,
  createReviewBulkOperationJob,
} from '../reviewServing/reviewBulkOperationService.ts'
import {getAppDatabaseService} from '../services/appDatabaseService.ts'
import {getJsonValue, getSqlLiteral} from '../services/appQueryHelpers.ts'
import {getCurrentReviewConfigHash} from '../services/reviewServingProjectConfigIdentity.ts'
import {createRateLimitedLogger} from '../utils/rateLimitedLogger.ts'

const projectsAddArticlesLogger = createRateLimitedLogger({sink: 'file-only', windowMs: 30_000})

type AddArticlesJobRow = {
  criteriaJson: unknown
  jobId: string
  jobKind: string
  lastError: string | null
  processedCount: number
  status: string
  totalEstimate: number | null
}

const getTargetProjectId = (criteriaJson: unknown) => {
  const criteria = getJsonValue(criteriaJson)
  const targetProjectId =
    criteria && typeof criteria === 'object' && !Array.isArray(criteria)
      ? (criteria as {targetProjectId?: unknown}).targetProjectId
      : null

  return typeof targetProjectId === 'string' ? targetProjectId : null
}

const getAddArticlesJob = async (sourceProjectId: string, jobId: string) => {
  const [row] = await getAppDatabaseService().queryJson<AddArticlesJobRow>(`
    SELECT
      job_id AS jobId,
      job_kind AS jobKind,
      criteria_json AS criteriaJson,
      status,
      processed_count AS processedCount,
      total_estimate AS totalEstimate,
      last_error AS lastError
    FROM app.review_bulk_operation_job
    WHERE job_id = ${getSqlLiteral(jobId)}
      AND project_id = ${getSqlLiteral(sourceProjectId)}
      AND job_kind = 'review.bulk.selection'
    LIMIT 1
  `)

  return row
    ? {
        job: {
          jobId: row.jobId,
          jobKind: row.jobKind,
          lastError: row.lastError,
          processedCount: row.processedCount,
          status: row.status,
          totalEstimate: row.totalEstimate,
        },
        targetProjectId: getTargetProjectId(row.criteriaJson),
      }
    : null
}

export const projectsAddArticlesRoutes = new Elysia()
  .post(
    '/api/projects/add_articles_by_filter',
    async ({body, set}) => {
      const reviewConfigHash = await getCurrentReviewConfigHash(body.sourceProjectId)
      const job = await createReviewBulkOperationJob({
        criteria: {
          from: body.from,
          hasDuplicateStudyRecords: body.hasDuplicateStudyRecords,
          hasStudyDecisionConflict: body.hasStudyDecisionConflict,
          listType: body.listType,
          llmStatus: body.llmStatus,
          operation: 'addToProject',
          prompts: body.prompts,
          requestId: randomUUID(),
          search: body.search,
          sourceProjectId: body.sourceProjectId,
          targetProjectId: body.targetProjectId,
          to: body.to,
        },
        filters: {
          from: body.from,
          hasDuplicateStudyRecords: body.hasDuplicateStudyRecords,
          hasStudyDecisionConflict: body.hasStudyDecisionConflict,
          listType: body.listType,
          llmStatus: body.llmStatus,
          prompts: body.prompts,
          search: body.search,
          to: body.to,
        },
        jobKind: 'review.bulk.selection',
        projectId: body.sourceProjectId,
        reviewConfigHash,
        searchMode: body.search ? 'tokenPrefix' : 'none',
        searchText: body.search ?? null,
        snapshot: {type: 'latest'},
      })

      projectsAddArticlesLogger.force(
        'projects.add-articles.applied-filter-summary',
        'Articles add-by-filter job created',
        'log',
        {
          targetProjectId: body.targetProjectId,
          sourceProjectId: body.sourceProjectId,
          listType: body.listType,
          llmStatus: body.llmStatus,
          filters: {
            from: body.from,
            to: body.to,
            search: body.search,
            prompts: body.prompts,
            hasDuplicateStudyRecords: body.hasDuplicateStudyRecords,
            hasStudyDecisionConflict: body.hasStudyDecisionConflict,
          },
          jobId: job.jobId,
        },
      )

      set.status = 202
      return {status: 'pending', success: true, job, targetProjectId: body.targetProjectId}
    },
    {
      body: t.Object({
        targetProjectId: t.String(),
        sourceProjectId: t.String(),
        listType: t.Union([t.Literal('llm'), t.Literal('human'), t.Literal('both'), t.Literal('unassessed')]),
        llmStatus: t.Optional(t.Union([t.Literal('complete'), t.Literal('both'), t.Literal('partial')])),
        prompts: t.Optional(t.Record(t.String(), t.Array(t.String()))),
        hasDuplicateStudyRecords: t.Optional(t.Boolean()),
        hasStudyDecisionConflict: t.Optional(t.Boolean()),
        from: t.Optional(t.String()),
        to: t.Optional(t.String()),
        search: t.Optional(t.String()),
      }),
    },
  )
  .post(
    '/api/projects/add_articles_by_ids',
    async ({body, set}) => {
      const ids = Array.isArray(body.articleIds) ? body.articleIds : [body.articleIds]
      assertArticleIdOnlyBulkOperationCaps(ids)
      const job = await createReviewBulkOperationJob({
        criteria: {
          articleIds: ids,
          operation: 'addToProject',
          requestId: randomUUID(),
          sourceProjectId: body.sourceProjectId,
          targetProjectId: body.targetProjectId,
        },
        filters: {},
        jobKind: 'review.bulk.selection',
        projectId: body.sourceProjectId,
        searchMode: 'none',
        searchText: null,
        snapshot: {type: 'latest'},
      })

      projectsAddArticlesLogger.force(
        'projects.add-articles.applied-ids-summary',
        'Articles add-by-ids job created',
        'log',
        {
          targetProjectId: body.targetProjectId,
          sourceProjectId: body.sourceProjectId,
          providedTotal: ids.length,
          jobId: job.jobId,
        },
      )

      set.status = 202
      return {status: 'pending', success: true, job, targetProjectId: body.targetProjectId, providedTotal: ids.length}
    },
    {
      body: t.Object({
        targetProjectId: t.String(),
        sourceProjectId: t.String(),
        articleIds: t.Union([t.Array(t.String()), t.String()]),
      }),
    },
  )
  .get(
    '/api/projects/add_articles_jobs',
    async ({query}) => {
      const result = await getAddArticlesJob(query.sourceProjectId, query.jobId)

      if (!result) {
        throw new Error('Add articles job not found')
      }

      return {success: true, ...result}
    },
    {query: t.Object({jobId: t.String(), sourceProjectId: t.String()})},
  )
