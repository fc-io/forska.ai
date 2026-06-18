import type {
  ArticlesReviewsCountResponse,
  ArticlesReviewsParams,
  ArticlesReviewsResponse,
} from '../../services/olap/olapTypes.ts'
import {getAppDatabaseService} from '../services/appDatabaseService.ts'
import {
  getActiveReviewServingSnapshotManifest,
  getLastKnownGoodReviewServingSnapshotManifest,
  type ReviewServingManifestRepositoryDatabase,
  type ReviewServingSnapshotManifest,
} from './reviewServingManifestRepository.ts'
import {readReviewServingRows, type ReviewServingReaderDatabase} from './reviewServingReader.ts'

type ReviewServingArticleRow = {
  activity_sort_at?: unknown
  article_external_id?: string | null
  article_id?: string
  article_title?: string | null
  articleExternalId?: string | null
  articleId?: string
  articleTitle?: string | null
  journal_title?: string | null
  journalTitle?: string | null
  selected_import_route_id?: string | null
  selectedImportRouteId?: string | null
  sort_key?: unknown
  url?: string | null
}

type ReviewServingJudgmentRow = {
  answered_original?: string | null
  answered_original_as_array?: string[] | null
  article_id?: string
  detail_updated_at?: unknown
  judgment_id?: string | null
  judgment_payload_json?: unknown
  model_id?: string | null
  prompt_id?: string
}

type ReviewServingCountRow = {
  availability?: string
  count_value?: number | null
  countValue?: number | null
  stale_reason?: string | null
}

type ReviewServingLlmReviewRouteDependencies = {
  database?: ReviewServingReaderDatabase
  manifestDatabase?: ReviewServingManifestRepositoryDatabase
}

const maxReviewPageSize = 100
const defaultReviewLimit = 100
const dynamicFilterKey = 'filter:dynamic'
const listAllFilterKey = 'list:all'

const getDateValue = (value: unknown) => {
  if (value instanceof Date) {
    return value
  }

  return typeof value === 'string' || typeof value === 'number' ? new Date(value) : null
}

const getJsonValue = (value: unknown) => {
  return typeof value === 'string' ? (JSON.parse(value) as unknown) : value
}

const getManifest = async (projectId: string, dependencies?: ReviewServingLlmReviewRouteDependencies) => {
  const manifestDatabase =
    dependencies?.manifestDatabase ?? (getAppDatabaseService() as ReviewServingManifestRepositoryDatabase)
  const active = await getActiveReviewServingSnapshotManifest({projectId, reviewConfigHash: null}, manifestDatabase)

  return active ?? getLastKnownGoodReviewServingSnapshotManifest({projectId, reviewConfigHash: null}, manifestDatabase)
}

const getLimit = (value: number | string) => {
  const parsed = typeof value === 'number' ? value : parseInt(value, 10)

  return Math.min(Math.max(Number.isFinite(parsed) ? parsed : defaultReviewLimit, 1), maxReviewPageSize)
}

const getPage = (value: number | string | undefined) => {
  const parsed = typeof value === 'number' ? value : parseInt(value ?? '1', 10)

  return Math.max(Number.isFinite(parsed) ? parsed : 1, 1)
}

const getPromptAnswerFilters = (prompts: Record<string, string[]> | undefined) => {
  return Object.entries(prompts ?? {}).flatMap(([promptId, answers]) => {
    return answers.map((answer) => {
      return `${promptId}:${answer}`
    })
  })
}

const getRouteFilters = (params: ArticlesReviewsParams) => {
  const promptAnswer = getPromptAnswerFilters(params.prompts)
  const searchTokenPrefix = typeof params.search === 'string' && params.search.trim() ? params.search.trim() : undefined

  return {
    ...(params.from ? {articleCreatedAtFrom: params.from} : {}),
    ...(params.to ? {articleCreatedAtTo: params.to} : {}),
    ...(params.hasDuplicateStudyRecords ? {duplicateFlag: 'true'} : {}),
    ...(params.hasStudyDecisionConflict ? {conflictFlag: 'true'} : {}),
    ...(params.llmStatus ? {llmStatus: params.llmStatus} : {}),
    ...(promptAnswer.length > 0 ? {promptAnswer} : {}),
    ...(searchTokenPrefix ? {searchTokenPrefix} : {}),
  }
}

const hasDynamicFilters = (params: ArticlesReviewsParams) => {
  return Object.keys(getRouteFilters(params)).length > 0
}

const getCountFilterKey = (params: ArticlesReviewsParams) => {
  return hasDynamicFilters(params) ? dynamicFilterKey : listAllFilterKey
}

const getReaderDependencies = (dependencies?: ReviewServingLlmReviewRouteDependencies) => {
  return {
    ...(dependencies?.database ? {database: dependencies.database} : {}),
    ...(dependencies?.manifestDatabase
      ? {diagnosticsDatabase: dependencies.manifestDatabase, manifestDatabase: dependencies.manifestDatabase}
      : {}),
  }
}

const getBaseReaderRequest = (
  params: ArticlesReviewsParams,
  manifest: ReviewServingSnapshotManifest,
  limit: number,
) => {
  const searchTokenPrefix = typeof params.search === 'string' && params.search.trim() ? params.search.trim() : null

  return {
    allowStale: true,
    filters: getRouteFilters(params),
    limit,
    listMode: 'llm' as const,
    projectId: params.projectId,
    reviewConfigHash: manifest.reviewConfigHash,
    searchMode: searchTokenPrefix ? ('tokenPrefix' as const) : ('none' as const),
    searchState: searchTokenPrefix
      ? ({availability: 'ready' as const, snapshotId: manifest.snapshotId} as const)
      : null,
    searchTokenPrefix,
    snapshotId: manifest.snapshotId,
  }
}

const getCountState = (params: ArticlesReviewsParams, manifest: ReviewServingSnapshotManifest) => {
  const filterKey = getCountFilterKey(params)
  const key = hasDynamicFilters(params) ? ('review.list.filteredTotal' as const) : ('review.list.total' as const)

  return {availability: 'ready' as const, filterKey, key, snapshotId: manifest.snapshotId, value: 0}
}

const getCountValue = async (
  params: ArticlesReviewsParams,
  manifest: ReviewServingSnapshotManifest,
  dependencies?: ReviewServingLlmReviewRouteDependencies,
) => {
  const limit = 1
  const filterKey = getCountFilterKey(params)
  const namedCountKey = hasDynamicFilters(params) ? 'review.list.filteredTotal' : 'review.list.total'
  const result = await readReviewServingRows<ReviewServingCountRow>(
    {
      ...getBaseReaderRequest(params, manifest, limit),
      contractKey: 'review.llm.count',
      countFilterKey: filterKey,
      countState: getCountState(params, manifest),
      limit,
      namedCountKey,
      searchMode: 'none',
      searchState: null,
      searchTokenPrefix: null,
    },
    getReaderDependencies(dependencies),
  )

  if (result.status === 'rejected') {
    throw new Error(`reviewServingReader rejected LLM review count: ${result.reason}`)
  }

  const countRow = result.rows[0]

  if (countRow?.availability === 'unavailable') {
    throw new Error(countRow.stale_reason ?? 'Review count is unavailable for the requested filter scope')
  }

  return Number(countRow?.count_value ?? countRow?.countValue ?? 0)
}

const getArticleId = (row: ReviewServingArticleRow) => {
  return row.article_id ?? row.articleId ?? ''
}

const getArticleExternalId = (row: ReviewServingArticleRow) => {
  return row.article_external_id ?? row.articleExternalId ?? null
}

const getJudgmentPayload = (row: ReviewServingJudgmentRow) => {
  return getJsonValue(row.judgment_payload_json ?? null) as Record<string, unknown> | null
}

const getPayloadString = (value: unknown) => {
  return typeof value === 'string' ? value : ''
}

const getJudgmentRowsByArticleId = (rows: readonly ReviewServingJudgmentRow[]) => {
  return rows.reduce((acc, row) => {
    const articleId = row.article_id ?? ''
    const payload = getJudgmentPayload(row)
    const judgment = {
      id: row.judgment_id ?? getPayloadString(payload?.id),
      createdAt: getPayloadString(payload?.createdAt) || getPayloadString(row.detail_updated_at),
      articleId,
      articleTitle: '',
      articleCreatedAt: null,
      articleUpdatedAt: null,
      articleCreatedYear: null,
      articleUpdatedYear: null,
      articleImportRoute: null,
      articleImportedBy: null,
      promptId: row.prompt_id ?? getPayloadString(payload?.promptId),
      modelId: row.model_id ?? getPayloadString(payload?.modelId),
      answeredOriginal: row.answered_original ?? (payload?.answeredOriginal as string | null) ?? null,
      answeredOriginalAsArray: row.answered_original_as_array ?? [],
      explanation: (payload?.explanation as string | null) ?? null,
      quotes: payload?.quotes ?? null,
    }
    const existing = acc.get(articleId) ?? []

    return acc.set(articleId, [...existing, judgment])
  }, new Map<string, ArticlesReviewsResponse['data'][number]['judgments']>())
}

const getResponseRows = (
  rows: readonly ReviewServingArticleRow[],
  judgmentRows: readonly ReviewServingJudgmentRow[],
): ArticlesReviewsResponse['data'] => {
  const judgmentsByArticleId = getJudgmentRowsByArticleId(judgmentRows)

  return rows.map((row) => {
    const articleId = getArticleId(row)
    const articleCreatedAt = getDateValue(row.sort_key)
    const articleUpdatedAt = getDateValue(row.activity_sort_at)
    const judgments = judgmentsByArticleId.get(articleId) ?? []

    return {
      id: articleId,
      articleTitle: row.article_title ?? row.articleTitle ?? null,
      articleCreatedAt,
      articleUpdatedAt,
      articleId: getArticleExternalId(row),
      journalTitle: row.journal_title ?? row.journalTitle ?? null,
      selectedImportRouteId: row.selected_import_route_id ?? row.selectedImportRouteId ?? null,
      url: row.url ?? null,
      judgments,
      judgedPromptIds: judgments.map((judgment) => {
        return judgment.promptId
      }),
      isFullyJudged: false,
    }
  })
}

export const getLlmReviewArticlesFromServing = async (
  params: ArticlesReviewsParams,
  dependencies?: ReviewServingLlmReviewRouteDependencies,
): Promise<ArticlesReviewsResponse> => {
  const manifest = await getManifest(params.projectId, dependencies)
  const page = getPage(params.page)
  const limit = getLimit(params.limit)

  if (!manifest) {
    throw new Error('Review serving snapshot is unavailable')
  }

  const rowsResult = await readReviewServingRows<ReviewServingArticleRow>(
    {...getBaseReaderRequest(params, manifest, limit), contractKey: 'review.llm.rows', cursor: params.cursor ?? null},
    getReaderDependencies(dependencies),
  )

  if (rowsResult.status === 'rejected') {
    throw new Error(`reviewServingReader rejected LLM review rows: ${rowsResult.reason}`)
  }

  const pageRows = rowsResult.rows.slice(0, limit)
  const articleIds = pageRows.map(getArticleId)
  const judgmentsResult =
    articleIds.length === 0
      ? null
      : await readReviewServingRows<ReviewServingJudgmentRow>(
          {
            ...getBaseReaderRequest(params, manifest, Math.min(articleIds.length * 128, 10_000)),
            articleIds,
            contractKey: 'review.llm.list.judgments',
            estimatedHydratedPayloadBytes: articleIds.length * 10_000,
            estimatedResultBytes: articleIds.length * 20_000,
            filters: {},
            limit: Math.min(articleIds.length * 128, 10_000),
            searchMode: 'none',
            searchState: null,
            searchTokenPrefix: null,
          },
          getReaderDependencies(dependencies),
        )

  if (judgmentsResult?.status === 'rejected') {
    throw new Error(`reviewServingReader rejected LLM review judgments: ${judgmentsResult.reason}`)
  }

  const totalCount = await getCountValue(params, manifest, dependencies)
  const lastRow = pageRows[pageRows.length - 1]

  return {
    data: getResponseRows(pageRows, judgmentsResult?.rows ?? []),
    totalCount,
    page,
    limit,
    totalPages: Math.ceil(totalCount / limit),
    nextCursor: rowsResult.rows.length > limit && lastRow ? rowsResult.diagnostics.filterSignature : null,
  }
}

export const countLlmReviewArticlesFromServing = async (
  params: ArticlesReviewsParams,
  dependencies?: ReviewServingLlmReviewRouteDependencies,
): Promise<ArticlesReviewsCountResponse> => {
  const manifest = await getManifest(params.projectId, dependencies)
  const limit = getLimit(params.limit)

  if (!manifest) {
    throw new Error('Review serving snapshot is unavailable')
  }

  const totalCount = await getCountValue({...params, limit, page: 1}, manifest, dependencies)

  return {totalCount, totalPages: Math.ceil(totalCount / limit)}
}
