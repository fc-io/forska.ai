import {randomUUID} from 'node:crypto'

import {Elysia, t} from 'elysia'

import {getProviderModelMetadataOptions} from '../providers/providerModelMetadata.ts'
import {appendArticleReviewServingDeltasForIds} from '../reviewServing/articleReviewServingDeltaService.ts'
import {
  assertArticleIdOnlyBulkOperationCaps,
  createReviewBulkOperationJob,
} from '../reviewServing/reviewBulkOperationService.ts'
import {getAppDatabaseService} from '../services/appDatabaseService.ts'
import {
  escapeSqlString,
  getDateValue,
  getJsonValue,
  getQuotedStringList,
  getTimestampLiteral,
} from '../services/appQueryHelpers.ts'
import {storeImportedArticlesWithTx} from '../services/articleImportStoreService.ts'
import {getAppQueryService} from '../services/getAppQueryService.ts'
import {getPdfFetchJobFromDatabase} from '../services/pdfFetchJobs.ts'
import {getCurrentReviewConfigHash} from '../services/reviewServingProjectConfigIdentity.ts'
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
  modelMetadataJson: unknown
  modelName: string | null
  modelProvider: string | null
  modelVersion: string | null
}

const getDateFilterValue = (value: Date | string | undefined | null) => {
  const date = getDateValue(value)

  return date ? date.toISOString() : undefined
}

const isDateOnlyFilterValue = (value: unknown) => {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
}

const getBoundedDateFilterValue = (value: Date | string | undefined | null): string | undefined => {
  return isDateOnlyFilterValue(value) ? String(value) : getDateFilterValue(value)
}

const getLaterDateFilter = (left: Date | string | undefined | null, right: Date | string | undefined | null) => {
  const leftDate = getDateValue(left)
  const rightDate = getDateValue(right)
  const value = !leftDate || (rightDate && rightDate > leftDate) ? right : left

  return getBoundedDateFilterValue(value)
}

const getEarlierDateFilter = (left: Date | string | undefined | null, right: Date | string | undefined | null) => {
  const leftDate = getDateValue(left)
  const rightDate = getDateValue(right)
  const value = !leftDate || (rightDate && rightDate < leftDate) ? right : left

  return getBoundedDateFilterValue(value)
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
    modelThinking: getProviderModelMetadataOptions(getJsonValue(row.modelMetadataJson)).thinking,
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
      .transaction(async (tx) => {
        const sourceUpdatedAt = new Date()
        const whereSql = `full_text_pdf LIKE 'assets/article_pdfs/%'
          AND full_text_source IS NOT NULL
          AND full_text_source != 'user_upload'`
        const articleRows = await tx.queryJson<{articleId: string}>(`
          SELECT id AS articleId
          FROM app.article
          WHERE ${whereSql}
        `)
        const articleIds = articleRows.map((row) => {
          return row.articleId
        })
        await tx.run(
          `
          UPDATE app.article
          SET full_text_fetched_at = NULL,
              full_text_pdf = NULL,
              full_text_source = NULL,
              full_text_original_format = NULL,
              updated_at = ${getTimestampLiteral(sourceUpdatedAt)}
          WHERE ${whereSql}
        `,
        )
        await appendArticleReviewServingDeltasForIds(tx, {
          articleIds,
          changedFields: ['fullTextPDF'],
          sourceMutationKey: `ArticlesRoutes.pdfFetchReset|${sourceUpdatedAt.toISOString()}`,
          sourceOperation: 'update',
          sourceUpdatedAt,
        })
      })
      .then(() => {
        console.log('[pdf-fetch-reset] Reset fetched article PDFs')
      })

    return {success: true, message: 'Reset started in background'}
  })
  .post(
    '/api/articles/pdf-fetch-bulk',
    async ({body, set}) => {
      assertArticleIdOnlyBulkOperationCaps(body.articleIds)

      const job = await createReviewBulkOperationJob({
        batchSize: body.concurrency,
        criteria: {
          articleIds: body.articleIds,
          concurrency: body.concurrency,
          forceRefetch: body.forceRefetch,
          operation: 'pdfFetch',
          requestId: randomUUID(),
        },
        filters: {},
        jobKind: 'review.pdf.selection',
        projectId: 'article-id-only',
        searchMode: 'none',
        searchText: null,
        snapshot: {type: 'latest'},
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
      const reviewConfigHash = await getCurrentReviewConfigHash(body.sourceProjectId)
      const job = await createReviewBulkOperationJob({
        criteria: {
          concurrency: body.concurrency,
          forceRefetch: body.forceRefetch,
          from: body.from,
          hasDuplicateStudyRecords: body.hasDuplicateStudyRecords,
          hasStudyDecisionConflict: body.hasStudyDecisionConflict,
          listType: body.listType,
          llmStatus: body.llmStatus,
          operation: 'pdfFetch',
          prompts: body.prompts,
          search: body.search,
          sourceProjectId: body.sourceProjectId,
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
        jobKind: 'review.pdf.selection',
        projectId: body.sourceProjectId,
        reviewConfigHash,
        searchMode: body.search ? 'tokenPrefix' : 'none',
        searchText: body.search,
        snapshot: {type: 'latest'},
      })

      set.status = 202
      return {success: true, job}
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
      const projectBounds = await getAppQueryService().getProjectReviewConfig(body.projectId)

      if (!projectBounds) {
        throw new Error('Project not found')
      }

      const reviewConfigHash = await getCurrentReviewConfigHash(body.projectId)
      const effectiveFrom = getLaterDateFilter(body.from, projectBounds.dateFrom)
      const effectiveTo = getEarlierDateFilter(body.to, projectBounds.dateTo)

      const job = await createReviewBulkOperationJob({
        criteria: {
          concurrency: body.concurrency,
          forceRefetch: body.forceRefetch,
          from: effectiveFrom,
          hasDuplicateStudyRecords: body.hasDuplicateStudyRecords,
          hasStudyDecisionConflict: body.hasStudyDecisionConflict,
          operation: 'pdfFetch',
          search: body.search,
          selectionScope: 'project',
          sourceProjectId: body.projectId,
          to: effectiveTo,
        },
        filters: {
          from: effectiveFrom,
          hasDuplicateStudyRecords: body.hasDuplicateStudyRecords,
          hasStudyDecisionConflict: body.hasStudyDecisionConflict,
          search: body.search,
          to: effectiveTo,
        },
        jobKind: 'review.pdf.selection',
        projectId: body.projectId,
        reviewConfigHash,
        searchMode: body.search ? 'tokenPrefix' : 'none',
        searchText: body.search,
        snapshot: {type: 'latest'},
      })

      set.status = 202
      return {success: true, job}
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
      const job = await getPdfFetchJobFromDatabase(params.jobId)
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
      arxivId: string | null
      biorxivId: string | null
      doi: string | null
      medrxivId: string | null
      pubmedId: string | null
      sourceMetadata: unknown
      url: string | null
    }>(`
      SELECT
        id,
        article_id AS articleId,
        article_title AS articleTitle,
        TO_JSON(article_authors) AS articleAuthors,
        article_created_at AS articleCreatedAt,
        arxiv_id AS arxivId,
        biorxiv_id AS biorxivId,
        doi,
        medrxiv_id AS medrxivId,
        pubmed_id AS pubmedId,
        TO_JSON(source_metadata) AS sourceMetadata,
        url
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
        arxivId: row.arxivId,
        biorxivId: row.biorxivId,
        doi: row.doi,
        medrxivId: row.medrxivId,
        pubmedId: row.pubmedId,
        sourceMetadata: getJsonValue(row.sourceMetadata),
        url: row.url,
      }
    })

    return {data}
  })
  .post(
    '/api/articles/batch-upsert',
    async ({body, set}) => {
      const {entries} = body
      const rows = entries.map((entry) => {
        return {
          articleAuthors: entry.article_authors,
          articleCreatedAt: new Date(entry.article_created_at),
          articleId: entry.article_id,
          articleSummary: entry.article_summary,
          articleTitle: entry.article_title,
          articleUpdatedAt: new Date(entry.article_updated_at),
          articleVersion: Number.parseInt(entry.article_version, 10),
          arxivId: entry.arxiv_id ?? null,
          doi: entry.doi ?? null,
          importRoute: entry.import_route,
          originalData: entry.original_data as unknown,
          pubmedId: entry.pubmed_id ?? null,
        }
      })

      let importRefreshState = {acceptedCount: 0, importRouteIds: [] as string[]}

      await getAppDatabaseService().transaction(async (tx) => {
        importRefreshState = await storeImportedArticlesWithTx(tx, rows)
      })

      if (importRefreshState.acceptedCount !== entries.length) {
        set.status = 400
        return {
          data: null,
          error: `Failed to upsert all articles: accepted ${importRefreshState.acceptedCount} of ${entries.length} entries`,
        }
      }

      return {success: true, count: importRefreshState.acceptedCount}
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
          TO_JSON(m.metadata_json) AS modelMetadataJson,
          COALESCE(m.display_name, m.name, m.remote_model_id) AS modelName,
          pc.provider_kind AS modelProvider,
          m.variant AS modelVersion
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
