import {Elysia, t} from 'elysia'

import {selectArticleIdsByFilterOlap} from '../../services/olap/selectArticleIdsOlap.ts'
import {getArticleSourceMetadata, getOriginalDoi} from '../../utils/articleSourceMetadata.ts'
import {getAppDatabaseService} from '../services/appDatabaseService.ts'
import {
  escapeSqlString,
  getDateValue,
  getJsonValue,
  getProjectScopeClause,
  getQuotedStringList,
  getSqlLiteral,
  getTimestampLiteral,
} from '../services/appQueryHelpers.ts'
import {getAppQueryService} from '../services/getAppQueryService.ts'
import {getPdfFetchJob, startPdfFetchJob} from '../services/pdfFetchJobs.ts'
import {withErrorHandler} from '../utils/routeErrorHandler'

type ArticleJudgmentRow = {
  judgmentId: string
  judgmentCreatedAt: unknown
  judgmentUpdatedAt: unknown
  judgmentDeletedAt: unknown
  judgmentArticleId: string
  judgmentModelId: string
  judgmentPromptId: string
  judgmentProjectId: string | null
  judgmentUseTitle: boolean | null
  judgmentUseAbstract: boolean | null
  judgmentUseFulltext: boolean | null
  judgmentUseFulltextNoImages: boolean | null
  judgmentChunkingStrategy: string | null
  judgmentIsAnswered: boolean | null
  judgmentAnsweredOriginal: string | null
  judgmentAnsweredOriginalAsArray: unknown
  judgmentConfidenceOriginal: number | null
  judgmentExplanation: string | null
  judgmentQuotes: unknown
  judgmentSnapshotProjectId: string | null
  judgmentSnapshotProjectModelName: string | null
  promptOriginalText: string
  promptHeading: string | null
  modelName: string | null
  modelProvider: string | null
  modelVersion: string | null
}

const getArticleJudgmentValue = (row: ArticleJudgmentRow) => {
  const answeredOriginalAsArray = getJsonValue(row.judgmentAnsweredOriginalAsArray)
  const quotes = getJsonValue(row.judgmentQuotes)

  return {
    id: row.judgmentId,
    createdAt: getDateValue(row.judgmentCreatedAt),
    updatedAt: getDateValue(row.judgmentUpdatedAt),
    deletedAt: getDateValue(row.judgmentDeletedAt),
    articleId: row.judgmentArticleId,
    modelId: row.judgmentModelId,
    promptId: row.judgmentPromptId,
    projectId: row.judgmentProjectId,
    useTitle: row.judgmentUseTitle ?? true,
    useAbstract: row.judgmentUseAbstract ?? true,
    useFulltext: row.judgmentUseFulltext ?? false,
    useFulltextNoImages: row.judgmentUseFulltextNoImages ?? false,
    chunkingStrategy: row.judgmentChunkingStrategy,
    isAnswered: row.judgmentIsAnswered ?? false,
    answeredOriginal: row.judgmentAnsweredOriginal,
    answeredOriginalAsArray: Array.isArray(answeredOriginalAsArray)
      ? answeredOriginalAsArray.filter((value): value is string => {
          return typeof value === 'string'
        })
      : null,
    confidenceOriginal: row.judgmentConfidenceOriginal ?? 50,
    explanation: row.judgmentExplanation,
    quotes: Array.isArray(quotes) ? quotes : [],
    snapshotProjectId: row.judgmentSnapshotProjectId,
    snapshotProjectModelName: row.judgmentSnapshotProjectModelName,
    prompt: {originalText: row.promptOriginalText, promptHeading: row.promptHeading},
    modelName: row.modelName,
    modelProvider: row.modelProvider,
    modelVersion: row.modelVersion,
  }
}

export const articlesRoutes = new Elysia()
  .use(withErrorHandler())
  .get('/api/articles/conversion-stats', async () => {
    const [[totalFailedRow], lastFailedRows] = await Promise.all([
      getAppDatabaseService().queryJson<{count: number}>(`
        SELECT COUNT(*) AS count
        FROM app.article
        WHERE full_text_conversion_status = 'failed'
      `),
      getAppDatabaseService().queryJson<{
        id: string
        articleId: string | null
        title: string
        error: string | null
        attempts: number | null
        updatedAt: unknown
      }>(`
        SELECT
          id,
          article_id AS articleId,
          article_title AS title,
          full_text_conversion_error AS error,
          full_text_conversion_attempts AS attempts,
          updated_at AS updatedAt
        FROM app.article
        WHERE full_text_conversion_status = 'failed'
        ORDER BY updated_at DESC
        LIMIT 10
      `),
    ])

    const lastFailed = lastFailedRows.map((row) => {
      return {...row, updatedAt: getDateValue(row.updatedAt)}
    })

    return {lastFailed, totalFailed: totalFailedRow?.count ?? 0}
  })
  .post('/api/articles/conversion-reset', async () => {
    await getAppDatabaseService().run(`
      UPDATE app.article
      SET full_text_conversion_status = NULL,
          full_text_conversion_attempts = 0,
          full_text_conversion_error = NULL,
          updated_at = current_timestamp
      WHERE full_text_conversion_status = 'failed'
    `)

    return {success: true}
  })
  .post('/api/articles/pdf-fetch-reset', () => {
    void getAppDatabaseService()
      .run(
        `
        UPDATE app.article
        SET full_text_fetched_at = NULL,
            full_text_pdf = NULL,
            full_text_source = NULL,
            full_text_original_format = NULL,
            updated_at = current_timestamp
        WHERE full_text_pdf LIKE 'assets/article_pdfs/%'
          AND full_text_source IS NOT NULL
          AND full_text_source != 'user_upload'
      `,
      )
      .then(() => {
        console.log('[pdf-fetch-reset] Reset fetched article PDFs')
      })

    return {success: true, message: 'Reset started in background'}
  })
  .post(
    '/api/articles/pdf-fetch-bulk',
    ({body, set}) => {
      const job = startPdfFetchJob({
        articleIds: body.articleIds,
        concurrency: body.concurrency,
        forceRefetch: body.forceRefetch,
      })

      set.status = 202
      return {success: true, job}
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
      const articleIds = await selectArticleIdsByFilterOlap(
        body.sourceProjectId,
        body.listType,
        body.prompts,
        body.from,
        body.to,
        body.search,
      )

      const job = startPdfFetchJob({articleIds, concurrency: body.concurrency, forceRefetch: body.forceRefetch})

      set.status = 202
      return {success: true, selectionTotal: articleIds.length, job}
    },
    {
      body: t.Object({
        sourceProjectId: t.String(),
        listType: t.Union([t.Literal('llm'), t.Literal('human'), t.Literal('both'), t.Literal('unassessed')]),
        prompts: t.Optional(t.Record(t.String(), t.Array(t.String()))),
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
      const fromDate = body.from ? new Date(`${body.from}T00:00:00.000Z`) : null
      const toDate = body.to ? new Date(`${body.to}T23:59:59.999Z`) : null
      const searchTitle = typeof body.search === 'string' ? body.search.trim() : ''

      const projectBounds = await getAppQueryService().getProjectReviewConfig(body.projectId)

      if (!projectBounds) {
        throw new Error('Project not found')
      }

      const effectiveFromDate = (() => {
        if (projectBounds.dateFrom && fromDate) {
          return projectBounds.dateFrom > fromDate ? projectBounds.dateFrom : fromDate
        }
        return projectBounds.dateFrom ?? fromDate
      })()

      const effectiveToDate = (() => {
        if (projectBounds.dateTo && toDate) {
          return projectBounds.dateTo < toDate ? projectBounds.dateTo : toDate
        }
        return projectBounds.dateTo ?? toDate
      })()

      const whereParts = [
        getProjectScopeClause({
          articleAlias: 'a',
          importRouteIds: projectBounds.importRouteIds,
          projectId: body.projectId,
        }),
        effectiveFromDate ? `a.article_created_at >= ${getTimestampLiteral(effectiveFromDate)}` : null,
        effectiveToDate ? `a.article_created_at <= ${getTimestampLiteral(effectiveToDate)}` : null,
        searchTitle ? `LOWER(COALESCE(a.article_title, '')) LIKE LOWER('%${escapeSqlString(searchTitle)}%')` : null,
      ].filter((part): part is string => {
        return part !== null
      })

      const idRows = await getAppDatabaseService().queryJson<{id: string}>(`
        SELECT a.id AS id
        FROM app.article a
        WHERE ${whereParts.join(' AND ')}
      `)

      const articleIds = idRows.map((r) => {
        return r.id
      })

      const job = startPdfFetchJob({articleIds, concurrency: body.concurrency, forceRefetch: body.forceRefetch})

      set.status = 202
      return {success: true, selectionTotal: articleIds.length, job}
    },
    {
      body: t.Object({
        projectId: t.String(),
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
    ({params}) => {
      const job = getPdfFetchJob(params.jobId)
      if (!job) {
        throw new Error('Job not found')
      }
      return {job}
    },
    {params: t.Object({jobId: t.String()})},
  )
  .get('/api/articles/latest', async () => {
    const rows = await getAppDatabaseService().queryJson<{
      id: string
      articleId: string | null
      articleTitle: string
      articleAuthors: unknown
      articleCreatedAt: unknown
    }>(`
      SELECT
        id,
        article_id AS articleId,
        article_title AS articleTitle,
        TO_JSON(article_authors) AS articleAuthors,
        article_created_at AS articleCreatedAt
      FROM app.article
      ORDER BY COALESCE(article_created_at, created_at) DESC, created_at DESC, id DESC
      LIMIT 200
    `)

    const data = rows.map((row) => {
      const articleAuthors = getJsonValue(row.articleAuthors)
      return {
        id: row.id,
        articleId: row.articleId,
        articleTitle: row.articleTitle,
        articleAuthors: Array.isArray(articleAuthors)
          ? articleAuthors.filter((value): value is string => {
              return typeof value === 'string'
            })
          : null,
        articleCreatedAt: getDateValue(row.articleCreatedAt),
      }
    })

    return {data}
  })
  .post(
    '/api/articles/batch-upsert',
    async ({body}) => {
      const {entries} = body
      const normalizedEntries = entries.map((entry) => {
        const doi = entry.doi ?? getOriginalDoi(entry.original_data)
        const sourceMetadata = getArticleSourceMetadata({
          articleId: entry.article_id,
          importRoute: entry.import_route,
          originalData: entry.original_data,
        })

        return {...entry, doi, sourceMetadata}
      })

      await getAppDatabaseService().transaction(async (tx) => {
        const updatedAt = new Date()
        const inserted = await tx.queryJson<{id: string; articleId: string | null}>(`
          INSERT INTO app.article (
            id,
            article_id,
            article_title,
            article_summary,
            article_authors,
            article_updated_at,
            article_created_at,
            article_version,
            arxiv_id,
            doi,
            pubmed_id,
            import_route,
            original_data,
            source_metadata,
            updated_at
          )
          VALUES ${normalizedEntries
            .map((entry) => {
              return `(${[
                crypto.randomUUID(),
                entry.article_id,
                entry.article_title,
                entry.article_summary,
                entry.article_authors,
                new Date(entry.article_updated_at),
                new Date(entry.article_created_at),
                Number.parseInt(entry.article_version, 10),
                entry.arxiv_id ?? null,
                entry.doi ?? null,
                entry.pubmed_id ?? null,
                entry.import_route,
                entry.original_data ?? null,
                entry.sourceMetadata,
                updatedAt,
              ]
                .map((value) => {
                  return getSqlLiteral(value)
                })
                .join(', ')})`
            })
            .join(', ')}
          ON CONFLICT(article_id) DO UPDATE SET
            article_title = EXCLUDED.article_title,
            article_summary = EXCLUDED.article_summary,
            article_authors = EXCLUDED.article_authors,
            article_updated_at = EXCLUDED.article_updated_at,
            article_version = EXCLUDED.article_version,
            arxiv_id = EXCLUDED.arxiv_id,
            doi = EXCLUDED.doi,
            pubmed_id = EXCLUDED.pubmed_id,
            import_route = EXCLUDED.import_route,
            original_data = EXCLUDED.original_data,
            source_metadata = EXCLUDED.source_metadata,
            updated_at = ${getTimestampLiteral(updatedAt)}
          RETURNING id, article_id AS articleId
        `)

        const articleIdToRoute = new Map(
          normalizedEntries.map((entry) => {
            return [entry.article_id, entry.import_route]
          }),
        )
        const routeList = Array.from(
          new Set(
            normalizedEntries
              .map((entry) => {
                return entry.import_route
              })
              .filter((route): route is string => {
                return typeof route === 'string' && route.trim() !== ''
              }),
          ),
        )

        if (routeList.length > 0 && inserted.length > 0) {
          const importRoutes = await tx.queryJson<{id: string; route: string}>(`
            SELECT id, route
            FROM app.import_route
            WHERE route IN (${getQuotedStringList(routeList).join(', ')})
          `)
          const routeMap = new Map(
            importRoutes.map((route) => {
              return [route.route, route.id]
            }),
          )
          const linkValues = inserted
            .map((article) => {
              const route = article.articleId ? articleIdToRoute.get(article.articleId) : null
              const importRouteId = typeof route === 'string' ? routeMap.get(route) : null
              return importRouteId
                ? `(${getQuotedStringList([crypto.randomUUID(), article.id, importRouteId]).join(', ')}, current_timestamp, current_timestamp)`
                : null
            })
            .filter((value): value is string => {
              return value !== null
            })

          if (linkValues.length > 0) {
            await tx.run(`
              INSERT INTO app.article_import_route (id, article_id, import_route_id, created_at, updated_at)
              VALUES ${linkValues.join(', ')}
              ON CONFLICT(article_id, import_route_id) DO NOTHING
            `)
          }
        }
      })

      return {success: true, count: entries.length}
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
      const {q} = query

      if (!q || q.trim() === '') {
        return {data: []}
      }

      const searchTerm = q.trim()
      const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(searchTerm)

      const searchResults = await getAppDatabaseService().queryJson<{
        id: string
        createdAt: unknown
        articleId: string | null
        articleTitle: string
        articleAuthors: unknown
      }>(`
        SELECT
          id,
          created_at AS createdAt,
          article_id AS articleId,
          article_title AS articleTitle,
          TO_JSON(article_authors) AS articleAuthors
        FROM app.article
        WHERE ${isUuid ? `id = '${escapeSqlString(searchTerm)}' OR` : ''}
          article_id = '${escapeSqlString(searchTerm)}'
          OR LOWER(COALESCE(article_title, '')) LIKE LOWER('%${escapeSqlString(searchTerm)}%')
        ORDER BY
          CASE
            WHEN ${isUuid ? `id = '${escapeSqlString(searchTerm)}'` : 'FALSE'} THEN 0
            WHEN article_id = '${escapeSqlString(searchTerm)}' THEN 1
            ELSE 2
          END,
          article_title ASC
        LIMIT 50
      `)

      const data = searchResults.map((row) => {
        const articleAuthors = getJsonValue(row.articleAuthors)
        return {
          id: row.id,
          createdAt: getDateValue(row.createdAt),
          articleId: row.articleId,
          articleTitle: row.articleTitle,
          articleAuthors: Array.isArray(articleAuthors)
            ? articleAuthors.filter((value): value is string => {
                return typeof value === 'string'
              })
            : null,
        }
      })

      return {data}
    },
    {query: t.Object({q: t.String()})},
  )
  .get(
    '/api/articles/:id',
    async ({params}) => {
      const {id} = params

      const [article] = await getAppQueryService().getFullArticlesByIds([id])

      if (!article) {
        throw new Error('Article not found')
      }

      const allArticleJudgments = await getAppDatabaseService().queryJson<ArticleJudgmentRow>(`
        SELECT
          j.id AS judgmentId,
          j.created_at AS judgmentCreatedAt,
          j.updated_at AS judgmentUpdatedAt,
          j.deleted_at AS judgmentDeletedAt,
          j.article_id AS judgmentArticleId,
          j.model_id AS judgmentModelId,
          j.prompt_id AS judgmentPromptId,
          j.project_id AS judgmentProjectId,
          j.use_title AS judgmentUseTitle,
          j.use_abstract AS judgmentUseAbstract,
          j.use_fulltext AS judgmentUseFulltext,
          j.use_fulltext_no_images AS judgmentUseFulltextNoImages,
          j.chunking_strategy AS judgmentChunkingStrategy,
          j.is_answered AS judgmentIsAnswered,
          j.answered_original AS judgmentAnsweredOriginal,
          TO_JSON(j.answered_original_as_array) AS judgmentAnsweredOriginalAsArray,
          j.confidence_original AS judgmentConfidenceOriginal,
          j.explanation AS judgmentExplanation,
          TO_JSON(j.quotes) AS judgmentQuotes,
          j.snapshot_project_id AS judgmentSnapshotProjectId,
          j.snapshot_project_model_name AS judgmentSnapshotProjectModelName,
          p.original_text AS promptOriginalText,
          p.prompt_heading AS promptHeading,
          COALESCE(m.display_name, m.name, m.remote_model_id, m.model_name) AS modelName,
          COALESCE(pc.provider_kind, m.provider) AS modelProvider,
          COALESCE(m.variant, m.version) AS modelVersion
        FROM app.judgment j
        INNER JOIN app.prompt p ON j.prompt_id = p.id
        LEFT JOIN app.model m ON j.model_id = m.id
        LEFT JOIN app.provider_connection pc ON pc.id = m.provider_connection_id
        WHERE j.article_id = '${escapeSqlString(id)}'
        ORDER BY j.created_at DESC NULLS LAST, j.id ASC
      `)

      const allJudgments = allArticleJudgments.map((row) => {
        return getArticleJudgmentValue(row)
      })

      const snapshotProjectIds = Array.from(
        new Set(
          allJudgments
            .map((j) => {
              return j.snapshotProjectId
            })
            .filter((id): id is string => {
              return Boolean(id)
            }),
        ),
      )
      const projectNameRows =
        snapshotProjectIds.length > 0
          ? await getAppDatabaseService().queryJson<{id: string; name: string}>(`
              SELECT id, name
              FROM app.project
              WHERE id IN (${getQuotedStringList(snapshotProjectIds).join(', ')})
            `)
          : []
      const projectsById = projectNameRows.reduce<Record<string, {name: string}>>((acc, row) => {
        acc[row.id] = {name: row.name}
        return acc
      }, {})

      return {article, allJudgments, projectsById}
    },
    {params: t.Object({id: t.String()})},
  )
  .delete(
    '/api/articles/:id',
    async ({params}) => {
      const {id} = params

      const [article] = await getAppDatabaseService().queryJson<{id: string}>(`
        SELECT id
        FROM app.article
        WHERE id = '${escapeSqlString(id)}'
        LIMIT 1
      `)

      if (!article) {
        throw new Error('Article not found')
      }

      const [judgmentRow] = await getAppDatabaseService().queryJson<{count: number}>(`
        SELECT COUNT(*) AS count
        FROM app.judgment
        WHERE article_id = '${escapeSqlString(id)}'
      `)

      const judgmentCount = judgmentRow?.count ?? 0
      if (judgmentCount > 0) {
        throw new Error(`Cannot delete article with ${judgmentCount} judgments`)
      }

      await getAppDatabaseService().run(`
        DELETE FROM app.article
        WHERE id = '${escapeSqlString(id)}'
      `)
      return {success: true, id}
    },
    {params: t.Object({id: t.String()})},
  )
