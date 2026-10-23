import {Elysia, t} from 'elysia'

import {withErrorHandler} from '../utils/routeErrorHandler'
import {articlesRoutesDeleteArticle} from './articlesRoutes/articlesRoutesDeleteArticle.ts'
import {articlesRoutesGetArticle} from './articlesRoutes/articlesRoutesGetArticle.ts'
import {articlesRoutesGetConversionStats} from './articlesRoutes/articlesRoutesGetConversionStats.ts'
import {articlesRoutesGetLatest} from './articlesRoutes/articlesRoutesGetLatest.ts'
import {articlesRoutesGetPdfFetchJob} from './articlesRoutes/articlesRoutesGetPdfFetchJob.ts'
import {articlesRoutesGetSearch} from './articlesRoutes/articlesRoutesGetSearch.ts'
import {articlesRoutesPostBatchUpsert} from './articlesRoutes/articlesRoutesPostBatchUpsert.ts'
import {articlesRoutesPostConversionReset} from './articlesRoutes/articlesRoutesPostConversionReset.ts'
import {articlesRoutesPostPdfFetchBulk} from './articlesRoutes/articlesRoutesPostPdfFetchBulk.ts'
import {articlesRoutesPostPdfFetchByFilter} from './articlesRoutes/articlesRoutesPostPdfFetchByFilter.ts'
import {articlesRoutesPostPdfFetchByProject} from './articlesRoutes/articlesRoutesPostPdfFetchByProject.ts'
import {articlesRoutesPostPdfFetchReset} from './articlesRoutes/articlesRoutesPostPdfFetchReset.ts'

export const articlesRoutes = new Elysia()
  .use(withErrorHandler())
  .get('/api/articles/conversion-stats', async () => {
    return articlesRoutesGetConversionStats()
  })
  .post('/api/articles/conversion-reset', async () => {
    return articlesRoutesPostConversionReset()
  })
  .post('/api/articles/pdf-fetch-reset', () => {
    return articlesRoutesPostPdfFetchReset()
  })
  .post(
    '/api/articles/pdf-fetch-bulk',
    async ({body, set}) => {
      return articlesRoutesPostPdfFetchBulk({body, set})
    },
    {
      body: t.Object({
        articleIds: t.Array(t.String()),
        concurrency: t.Optional(t.Number()),
        forceRefetch: t.Optional(t.Boolean()),
      }),
    },
  )
  .post(
    '/api/articles/pdf-fetch-by-filter',
    async ({body, set}) => {
      return articlesRoutesPostPdfFetchByFilter({body, set})
    },
    {
      body: t.Object({
        sourceProjectId: t.String(),
        listType: t.Union([t.Literal('llm'), t.Literal('human'), t.Literal('both'), t.Literal('unassessed')]),
        llmStatus: t.Optional(t.Union([t.Literal('complete'), t.Literal('both'), t.Literal('partial')])),
        prompts: t.Optional(t.Record(t.String(), t.Array(t.String()))),
        hasDuplicateStudyRecords: t.Optional(t.Boolean()),
        hasStudyDecisionConflict: t.Optional(t.Boolean()),
        from: t.Optional(t.String()),
        to: t.Optional(t.String()),
        search: t.Optional(t.String()),
        concurrency: t.Optional(t.Number()),
        forceRefetch: t.Optional(t.Boolean()),
      }),
    },
  )
  .post(
    '/api/articles/pdf-fetch-by-project',
    async ({body, set}) => {
      return articlesRoutesPostPdfFetchByProject({body, set})
    },
    {
      body: t.Object({
        projectId: t.String(),
        hasDuplicateStudyRecords: t.Optional(t.Boolean()),
        hasStudyDecisionConflict: t.Optional(t.Boolean()),
        from: t.Optional(t.String()),
        to: t.Optional(t.String()),
        search: t.Optional(t.String()),
        concurrency: t.Optional(t.Number()),
        forceRefetch: t.Optional(t.Boolean()),
      }),
    },
  )
  .get(
    '/api/articles/pdf-fetch-jobs/:jobId',
    async ({params}) => {
      return articlesRoutesGetPdfFetchJob({params})
    },
    {params: t.Object({jobId: t.String()})},
  )
  .get('/api/articles/latest', async () => {
    return articlesRoutesGetLatest()
  })
  .post(
    '/api/articles/batch-upsert',
    async ({body, set}) => {
      return articlesRoutesPostBatchUpsert({body, set})
    },
    {
      body: t.Object({
        entries: t.Array(
          t.Object({
            article_id: t.String(),
            article_title: t.String(),
            article_summary: t.String(),
            article_authors: t.Array(t.String()),
            article_updated_at: t.String(),
            article_created_at: t.String(),
            article_version: t.String(),
            arxiv_id: t.Optional(t.String()),
            doi: t.Optional(t.String()),
            pubmed_id: t.Optional(t.String()),
            import_route: t.String(),
            original_data: t.Optional(t.Any()),
          }),
        ),
      }),
    },
  )
  .get(
    '/api/articles/search',
    async ({query}) => {
      return articlesRoutesGetSearch({query})
    },
    {query: t.Object({q: t.String()})},
  )
  .get(
    '/api/articles/:id',
    async ({params}) => {
      return articlesRoutesGetArticle({params})
    },
    {params: t.Object({id: t.String()})},
  )
  .delete(
    '/api/articles/:id',
    async ({params}) => {
      return articlesRoutesDeleteArticle({params})
    },
    {params: t.Object({id: t.String()})},
  )
