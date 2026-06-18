import {Elysia, t} from 'elysia'

import {createReviewBulkOperationJob} from '../reviewServing/reviewBulkOperationService.ts'
import {insertArticlesIntoProject} from '../services/insertArticlesIntoProject.ts'
import {createRateLimitedLogger} from '../utils/rateLimitedLogger.ts'

const projectsAddArticlesLogger = createRateLimitedLogger({sink: 'file-only', windowMs: 30_000})

export const projectsAddArticlesRoutes = new Elysia()
  .post(
    '/api/projects/add_articles_by_filter',
    async ({body}) => {
      const job = await createReviewBulkOperationJob({
        criteria: {
          from: body.from,
          hasDuplicateStudyRecords: body.hasDuplicateStudyRecords,
          hasStudyDecisionConflict: body.hasStudyDecisionConflict,
          listType: body.listType,
          llmStatus: body.llmStatus,
          operation: 'addToProject',
          prompts: body.prompts,
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
        jobKind: body.search ? 'review.bulk.substringSelection' : 'review.bulk.selection',
        projectId: body.sourceProjectId,
        searchMode: body.search ? 'substring' : 'none',
        searchText: body.search,
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

      return {success: true, job, targetProjectId: body.targetProjectId}
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
    async ({body}) => {
      const ids = Array.isArray(body.articleIds) ? body.articleIds : [body.articleIds]
      const result = await insertArticlesIntoProject(body.targetProjectId, ids, body.sourceProjectId)

      projectsAddArticlesLogger.force('projects.add-articles.applied-ids-summary', 'Articles added by ids', 'log', {
        targetProjectId: body.targetProjectId,
        sourceProjectId: body.sourceProjectId,
        providedTotal: ids.length,
        ...result,
      })

      return {success: true, targetProjectId: body.targetProjectId, providedTotal: ids.length, ...result}
    },
    {
      body: t.Object({
        targetProjectId: t.String(),
        sourceProjectId: t.String(),
        articleIds: t.Union([t.Array(t.String()), t.String()]),
      }),
    },
  )
