import {Elysia, t} from 'elysia'

import {queryArticlesReviewsFromOlap} from '../../../services/olap/articlesReviewsOlap.ts'
import {getAppQueryService} from '../../services/getAppQueryService.ts'
import {assertProjectIsActive} from './projectAccessGuard.ts'

export const projectsRoutesGetArticlesReviews = new Elysia().post(
  '/api/articlesreviews',
  async ({body}) => {
    try {
      console.log('[Articles Reviews API] Request:', {
        projectId: body.projectId,
        page: body.page,
        limit: body.limit,
        from: body.from,
        to: body.to,
        search: body.search,
        promptFilters: Object.keys(body.prompts || {}).length,
      })

      const page = parseInt(body?.page ?? '1', 10)
      const limit = parseInt(body?.limit ?? '100', 10)

      await assertProjectIsActive(body.projectId)

      const result = await queryArticlesReviewsFromOlap({
        cursor: body.cursor,
        projectId: body.projectId,
        page,
        limit,
        from: body.from,
        to: body.to,
        search: body.search,
        prompts: body.prompts,
      })

      const hasInlineHydration = result.data.every((article) => {
        return Object.hasOwn(article, 'articleId')
      })

      if (hasInlineHydration) {
        console.log(`[Articles Reviews API] Returning ${result.data.length} articles`)
        return result
      }

      const articleIds = result.data.map((a) => {
        return a.id
      })
      const fullTextRows = await getAppQueryService().getReviewHydrationRows(articleIds)
      const fullTextById = fullTextRows.reduce(
        (acc, row) => {
          return {...acc, [row.id]: row}
        },
        {} as Record<string, (typeof fullTextRows)[number]>,
      )
      const data = result.data.map((article) => {
        const fullText = fullTextById[article.id]
        return {
          ...article,
          articleTitle: fullText ? fullText.articleTitle : article.articleTitle,
          articleCreatedAt: fullText ? fullText.articleCreatedAt : article.articleCreatedAt,
          articleUpdatedAt: fullText ? fullText.articleUpdatedAt : article.articleUpdatedAt,
          journalTitle: fullText?.sourceMetadata?.journalTitle ?? article.journalTitle,
          articleId: fullText?.articleId ?? null,
          url: fullText?.url ?? null,
          fullTextPDF: fullText?.fullTextPDF ?? null,
          fullTextFetchedAt: fullText?.fullTextFetchedAt ?? null,
          fullTextConversionStatus: fullText?.fullTextConversionStatus ?? null,
          sourceMetadata: fullText?.sourceMetadata ?? null,
        }
      })

      console.log(`[Articles Reviews API] Returning ${result.data.length} articles`)

      return {...result, data}
    } catch (error) {
      console.error('[Articles Reviews API] Error:', error)
      throw new Error(error instanceof Error ? error.message : 'Failed to fetch articles reviews', {cause: error})
    }
  },
  {
    body: t.Object({
      cursor: t.Optional(t.String()),
      from: t.Optional(t.String()),
      limit: t.String(),
      page: t.String(),
      projectId: t.String(),
      prompts: t.Record(t.String(), t.Array(t.String())),
      to: t.Optional(t.String()),
      search: t.Optional(t.String()),
    }),
  },
)
