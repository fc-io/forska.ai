import {Elysia, t} from 'elysia'

import {selectArticleIdsByFilterOlap} from '../../services/olap/selectArticleIdsOlap.ts'
import {insertArticlesIntoProject} from '../services/insertArticlesIntoProject.ts'

/**
 * Routes for adding articles to a project by various filter criteria.
 *
 * Uses the OLAP layer for LLM judgment queries (llm, unassessed, both list types)
 * and the app database for human judgment queries (human list type).
 */
export const projectsAddArticlesRoutes = new Elysia()
  .post(
    '/api/projects/add_articles_by_filter',
    async ({body}) => {
      const articleIds = await selectArticleIdsByFilterOlap(
        body.sourceProjectId,
        body.listType,
        body.llmStatus,
        body.prompts,
        body.from,
        body.to,
        body.search,
        body.hasDuplicateStudyRecords,
        body.hasStudyDecisionConflict,
      )

      // Upsert associations + auto-link prompts
      const result = await insertArticlesIntoProject(body.targetProjectId, articleIds, body.sourceProjectId)

      console.log('[api/projects/add_articles_by_filter] applied', {
        targetProjectId: body.targetProjectId,
        sourceProjectId: body.sourceProjectId,
        listType: body.listType,
        filters: {
          from: body.from,
          to: body.to,
          search: body.search,
          prompts: body.prompts,
          hasDuplicateStudyRecords: body.hasDuplicateStudyRecords,
          hasStudyDecisionConflict: body.hasStudyDecisionConflict,
        },
        selectionTotal: articleIds.length,
        ...result,
      })

      return {success: true, targetProjectId: body.targetProjectId, selectionTotal: articleIds.length, ...result}
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
    '/api/projects/add_artilces_by_ids',
    async ({body}) => {
      const ids = Array.isArray(body.articleIds) ? body.articleIds : [body.articleIds]
      const result = await insertArticlesIntoProject(body.targetProjectId, ids, body.sourceProjectId)

      console.log('[api/projects/add_artilces_by_ids] applied', {
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
