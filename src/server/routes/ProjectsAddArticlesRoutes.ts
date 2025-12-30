import {Elysia, t} from 'elysia'

import {selectArticleIdsByFilterClickHouse} from '../../services/clickhouse/selectArticleIdsClickHouse.ts'
import {insertArticlesIntoProject} from '../services/insertArticlesIntoProject.ts'
import {requireUserAuth} from '../utils/authGuard.ts'

/**
 * Routes for adding articles to a project by various filter criteria.
 *
 * Uses ClickHouse for LLM judgment queries (llm, unassessed, both list types)
 * and PostgreSQL for human judgment queries (human list type).
 */
export const projectsAddArticlesRoutes = new Elysia()
  .use(requireUserAuth())
  .post(
    '/api/projects/add_articles_by_filter',
    async ({body}) => {
      const articleIds = await selectArticleIdsByFilterClickHouse(
        body.sourceProjectId,
        body.listType,
        body.prompts,
        body.from,
        body.to,
        body.search,
      )

      // Upsert associations + auto-link prompts
      const result = await insertArticlesIntoProject(body.targetProjectId, articleIds, body.sourceProjectId)

      console.log('[api/projects/add_articles_by_filter] applied', {
        targetProjectId: body.targetProjectId,
        sourceProjectId: body.sourceProjectId,
        listType: body.listType,
        filters: {from: body.from, to: body.to, search: body.search, prompts: body.prompts},
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
        prompts: t.Optional(t.Record(t.String(), t.Array(t.String()))),
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
