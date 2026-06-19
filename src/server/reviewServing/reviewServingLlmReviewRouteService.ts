import type {
  ArticlesReviewsCountResponse,
  ArticlesReviewsParams,
  ArticlesReviewsResponse,
} from '../../services/olap/olapTypes.ts'
import {getAppDatabaseService} from '../services/appDatabaseService.ts'
import {getSqlLiteral} from '../services/appQueryHelpers.ts'
import {getCurrentReviewConfigHash} from '../services/reviewServingProjectConfigIdentity.ts'
import {
  getActiveReviewServingSnapshotManifest,
  getLastKnownGoodReviewServingSnapshotManifest,
  type ReviewServingManifestRepositoryDatabase,
  type ReviewServingSnapshotManifest,
} from './reviewServingManifestRepository.ts'
import {getEffectiveReviewServingDateFilters} from './reviewServingProjectDateBounds.ts'
import {readReviewServingRows, type ReviewServingReaderDatabase} from './reviewServingReader.ts'
import {getReviewServingTitleSearchTokens} from './reviewServingTitleSearchProjector.ts'

type ReviewServingArticleRow = {
  activity_sort_at?: unknown
  arxiv_id?: string | null
  arxivId?: string | null
  article_external_id?: string | null
  article_created_at?: unknown
  article_id?: string
  article_title?: string | null
  articleExternalId?: string | null
  articleCreatedAt?: unknown
  articleId?: string
  articleTitle?: string | null
  biorxiv_id?: string | null
  biorxivId?: string | null
  canonical_article_id?: string | null
  canonicalArticleId?: string | null
  doi?: string | null
  full_text_pdf?: string | null
  fullTextPDF?: string | null
  journal_title?: string | null
  journalTitle?: string | null
  llm_status_key?: string | null
  llmStatusKey?: string | null
  medrxiv_id?: string | null
  medrxivId?: string | null
  original_data?: unknown
  originalData?: unknown
  pmid?: string | null
  selected_import_route_id?: string | null
  selectedImportRouteId?: string | null
  source_metadata?: unknown
  sourceMetadata?: unknown
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
  placeholder_kind?: string | null
  placeholderKind?: string | null
  prompt_id?: string
}

type ReviewServingCountRow = {
  availability?: string
  count_value?: number | null
  countValue?: number | null
  stale_reason?: string | null
}

type ReviewServingLlmReviewRouteDependencies = {
  currentReviewConfigHash?: string | null
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

const getSearchTokenPrefixes = (search: string | null | undefined) => {
  return getReviewServingTitleSearchTokens(search ?? null)
}

const getSearchTokenPrefix = (search: string | null | undefined) => {
  return getSearchTokenPrefixes(search)[0] ?? null
}

const getManifestComponentIdentity = (manifest: ReviewServingSnapshotManifest, component: string) => {
  return [...manifest.componentState.required, ...manifest.componentState.optional].find((entry) => {
    return entry.component === component
  })?.projectionIdentity
}

const getManifest = async (projectId: string, dependencies?: ReviewServingLlmReviewRouteDependencies) => {
  const manifestDatabase =
    dependencies?.manifestDatabase ?? (getAppDatabaseService() as ReviewServingManifestRepositoryDatabase)
  const reviewConfigHash = dependencies?.currentReviewConfigHash ?? (await getCurrentReviewConfigHash(projectId))
  const active = await getActiveReviewServingSnapshotManifest({projectId, reviewConfigHash}, manifestDatabase)

  return active ?? getLastKnownGoodReviewServingSnapshotManifest({projectId, reviewConfigHash}, manifestDatabase)
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
  const searchTokenPrefixes = getSearchTokenPrefixes(params.search)
  const shouldRequireLlmJudgment = !params.llmStatus || params.llmStatus === 'both' || params.llmStatus === 'partial'

  return {
    ...(params.from ? {articleCreatedAtFrom: params.from} : {}),
    ...(params.to ? {articleCreatedAtTo: params.to} : {}),
    ...(params.hasDuplicateStudyRecords ? {duplicateFlag: 'true'} : {}),
    ...(params.hasStudyDecisionConflict ? {conflictFlag: 'true'} : {}),
    ...(shouldRequireLlmJudgment ? {llmHasJudgment: true} : {}),
    ...(params.llmStatus ? {llmStatus: params.llmStatus} : {}),
    ...(promptAnswer.length > 0 ? {promptAnswer} : {}),
    ...(searchTokenPrefixes.length > 0 ? {searchTokenPrefix: searchTokenPrefixes[0]} : {}),
  }
}

const getParamsWithEffectiveDateFilters = async (
  params: ArticlesReviewsParams,
  database: ReviewServingReaderDatabase,
) => {
  const dates = await getEffectiveReviewServingDateFilters(params, database)

  return {...params, from: dates.from, to: dates.to}
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
  const searchTokenPrefix = getSearchTokenPrefix(params.search)

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
    searchTokenPrefixes: getSearchTokenPrefixes(params.search),
    snapshotId: manifest.snapshotId,
  }
}

const getCountState = (params: ArticlesReviewsParams, manifest: ReviewServingSnapshotManifest) => {
  const filterKey = getCountFilterKey(params)
  const key = hasDynamicFilters(params) ? ('review.list.filteredTotal' as const) : ('review.list.total' as const)

  return {availability: 'ready' as const, filterKey, key, snapshotId: manifest.snapshotId, value: 0}
}

const getExclusiveDateToFilter = (value: unknown) => {
  if (typeof value !== 'string' || !isDateOnlyFilter(value)) {
    return typeof value === 'string' ? value : null
  }

  const date = new Date(`${value}T00:00:00.000Z`)
  date.setUTCDate(date.getUTCDate() + 1)

  return date.toISOString().slice(0, 10)
}

const isDateOnlyFilter = (value: string) => {
  return /^\d{4}-\d{2}-\d{2}$/.test(value)
}

const getDateToPredicate = (column: string, value: unknown) => {
  const dateTo = getExclusiveDateToFilter(value)

  return dateTo
    ? `AND ${column} ${typeof value === 'string' && isDateOnlyFilter(value) ? '<' : '<='} TIMESTAMPTZ ${getSqlLiteral(dateTo)}`
    : ''
}

const getPromptAnswerPredicates = (prompts: Record<string, string[]> | undefined) => {
  return Object.entries(prompts ?? {})
    .filter(([, values]) => {
      return values.length > 0
    })
    .map(([promptId, values], index) => {
      const filterValues = values.map((value) => {
        return `review:promptAnswer:${promptId}:${value}`
      })

      return `AND EXISTS (
        SELECT 1
        FROM mart.review_article_filter_posting_serving_v4 prompt_filter_${index}
        WHERE prompt_filter_${index}.project_id = serving.project_id
          AND prompt_filter_${index}.review_config_hash = serving.review_config_hash
          AND prompt_filter_${index}.snapshot_id = serving.snapshot_id
          AND prompt_filter_${index}.list_mode_key = serving.list_mode_key
          AND prompt_filter_${index}.article_id = serving.article_id
          AND prompt_filter_${index}.filter_kind = 'promptAnswer'
          AND prompt_filter_${index}.filter_value IN (SELECT unnest(${getSqlLiteral(filterValues)}::VARCHAR[]))
      )`
    })
}

const getCountValue = async (
  params: ArticlesReviewsParams,
  manifest: ReviewServingSnapshotManifest,
  dependencies?: ReviewServingLlmReviewRouteDependencies,
) => {
  if (hasDynamicFilters(params)) {
    return getFilteredCountValue(params, manifest, dependencies)
  }

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

const getFilteredCountValue = async (
  params: ArticlesReviewsParams,
  manifest: ReviewServingSnapshotManifest,
  dependencies?: ReviewServingLlmReviewRouteDependencies,
) => {
  const database = dependencies?.database ?? (getAppDatabaseService() as ReviewServingReaderDatabase)
  const filters = getRouteFilters(params)
  const llmStatusValue =
    filters.llmStatus === 'complete' ? 'answered' : filters.llmStatus === 'partial' ? 'unanswered' : null
  const searchTokenPrefixes = getSearchTokenPrefixes(params.search)
  const searchPredicate =
    searchTokenPrefixes.length > 0
      ? `AND NOT EXISTS (
        SELECT 1 FROM (SELECT unnest(${getSqlLiteral(searchTokenPrefixes)}::VARCHAR[]) AS token_prefix) search_prefix
        WHERE NOT EXISTS (
          SELECT 1
          FROM mart.review_title_search_serving_v4 search
          WHERE search.project_id = serving.project_id
            AND search.search_identity = ${getSqlLiteral(getManifestComponentIdentity(manifest, 'search') ?? '')}
            AND search.project_scope_identity = ${getSqlLiteral(getManifestComponentIdentity(manifest, 'projectScope') ?? '')}
            AND search.snapshot_id = serving.snapshot_id
            AND search.article_id = serving.article_id
            AND starts_with(search.token, search_prefix.token_prefix)
        )
      )`
      : ''
  const [row] = await database.queryJson<{totalCount: number}>(`
    SELECT COUNT(DISTINCT serving.article_id) AS totalCount
    FROM mart.review_article_serving_v4 serving
    WHERE serving.project_id = ${getSqlLiteral(params.projectId)}
      AND serving.review_config_hash = ${getSqlLiteral(manifest.reviewConfigHash)}
      AND serving.snapshot_id = ${getSqlLiteral(manifest.snapshotId)}
      AND serving.list_mode_key = 'llm'
      ${filters.articleCreatedAtFrom ? `AND serving.article_created_at >= TIMESTAMPTZ ${getSqlLiteral(filters.articleCreatedAtFrom)}` : ''}
      ${getDateToPredicate('serving.article_created_at', filters.articleCreatedAtTo)}
      ${filters.duplicateFlag ? 'AND serving.duplicate_flag = TRUE' : ''}
      ${filters.conflictFlag ? 'AND serving.conflict_flag = TRUE' : ''}
      ${filters.llmHasJudgment ? 'AND serving.llm_judged_prompt_count > 0' : ''}
      ${llmStatusValue ? `AND serving.llm_status_key = ${getSqlLiteral(llmStatusValue)}` : ''}
      ${getPromptAnswerPredicates(params.prompts).join('\n')}
      ${searchPredicate}
  `)

  return Number(row?.totalCount ?? 0)
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

const isPlaceholderJudgmentRow = (row: ReviewServingJudgmentRow) => {
  return (row.placeholder_kind ?? row.placeholderKind ?? null) !== null
}

const getJudgmentRowsByArticleId = (rows: readonly ReviewServingJudgmentRow[]) => {
  return rows
    .filter((row) => {
      return !isPlaceholderJudgmentRow(row)
    })
    .reduce((acc, row) => {
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
    const articleCreatedAt = getDateValue(row.article_created_at ?? row.articleCreatedAt)
    const articleUpdatedAt = getDateValue(row.activity_sort_at)
    const judgments = judgmentsByArticleId.get(articleId) ?? []

    return {
      id: articleId,
      articleTitle: row.article_title ?? row.articleTitle ?? null,
      articleCreatedAt,
      articleUpdatedAt,
      articleId: getArticleExternalId(row),
      arxivId: row.arxiv_id ?? row.arxivId ?? null,
      biorxivId: row.biorxiv_id ?? row.biorxivId ?? null,
      canonicalArticleId: row.canonical_article_id ?? row.canonicalArticleId ?? null,
      doi: row.doi ?? null,
      fullTextPDF: row.full_text_pdf ?? row.fullTextPDF ?? null,
      journalTitle: row.journal_title ?? row.journalTitle ?? null,
      medrxivId: row.medrxiv_id ?? row.medrxivId ?? null,
      originalData: row.original_data ?? row.originalData ?? null,
      pubmedId: row.pmid ?? null,
      selectedImportRouteId: row.selected_import_route_id ?? row.selectedImportRouteId ?? null,
      sourceMetadata: row.source_metadata ?? row.sourceMetadata ?? null,
      url: row.url ?? null,
      judgments,
      judgedPromptIds: judgments.map((judgment) => {
        return judgment.promptId
      }),
      isFullyJudged: (row.llm_status_key ?? row.llmStatusKey) === 'answered',
    }
  })
}

export const getLlmReviewArticlesFromServing = async (
  params: ArticlesReviewsParams,
  dependencies?: ReviewServingLlmReviewRouteDependencies,
): Promise<ArticlesReviewsResponse> => {
  const database = dependencies?.database ?? (getAppDatabaseService() as ReviewServingReaderDatabase)
  const effectiveParams = await getParamsWithEffectiveDateFilters(params, database)
  const manifest = await getManifest(params.projectId, dependencies)
  const page = getPage(effectiveParams.page)
  const limit = getLimit(effectiveParams.limit)

  if (!manifest) {
    throw new Error('Review serving snapshot is unavailable')
  }

  const rowsResult = await readReviewServingRows<ReviewServingArticleRow>(
    {
      ...getBaseReaderRequest(effectiveParams, manifest, limit + 1),
      contractKey: 'review.llm.rows',
      cursor: effectiveParams.cursor ?? null,
    },
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
            ...getBaseReaderRequest(effectiveParams, manifest, Math.min(articleIds.length * 128, 10_000)),
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

  const totalCount = await getCountValue(effectiveParams, manifest, {...dependencies, database})
  const lastRow = pageRows[pageRows.length - 1]
  const hasNextPage = rowsResult.rows.length > limit

  return {
    data: getResponseRows(pageRows, judgmentsResult?.rows ?? []),
    totalCount,
    page,
    limit,
    totalPages: Math.ceil(totalCount / limit),
    nextCursor: hasNextPage && lastRow ? rowsResult.getCursorForRow(lastRow as Record<string, unknown>) : null,
  }
}

export const countLlmReviewArticlesFromServing = async (
  params: ArticlesReviewsParams,
  dependencies?: ReviewServingLlmReviewRouteDependencies,
): Promise<ArticlesReviewsCountResponse> => {
  const database = dependencies?.database ?? (getAppDatabaseService() as ReviewServingReaderDatabase)
  const effectiveParams = await getParamsWithEffectiveDateFilters(params, database)
  const manifest = await getManifest(params.projectId, dependencies)
  const limit = getLimit(effectiveParams.limit)

  if (!manifest) {
    throw new Error('Review serving snapshot is unavailable')
  }

  const totalCount = await getCountValue({...effectiveParams, limit, page: 1}, manifest, {...dependencies, database})

  return {totalCount, totalPages: Math.ceil(totalCount / limit)}
}
