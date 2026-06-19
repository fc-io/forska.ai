import type {
  ArticlesReviewsBothParams,
  ArticlesReviewsBothResponse,
  ArticlesReviewsParams,
} from '../../services/olap/olapTypes.ts'
import {getAppDatabaseService} from '../services/appDatabaseService.ts'
import {getSqlLiteral} from '../services/appQueryHelpers.ts'
import {getCurrentReviewConfigHash} from '../services/reviewServingProjectConfigIdentity.ts'
import {normalizeSummaryAnswerValue} from '../utils/judgmentAnswers.ts'
import type {NamedReviewFastCountKey} from './reviewServingContracts.ts'
import {
  getActiveReviewServingSnapshotManifest,
  getLastKnownGoodReviewServingSnapshotManifest,
  type ReviewServingManifestRepositoryDatabase,
  type ReviewServingSnapshotManifest,
} from './reviewServingManifestRepository.ts'
import {getEffectiveReviewServingDateFilters} from './reviewServingProjectDateBounds.ts'
import {
  readReviewServingRows,
  type ReviewServingReaderDatabase,
  type ReviewServingReaderRequest,
} from './reviewServingReader.ts'
import {getReviewServingTitleSearchTokens} from './reviewServingTitleSearchProjector.ts'

type ReviewServingArticleRow = {
  activity_sort_at?: unknown
  article_created_at?: unknown
  arxiv_id?: string | null
  arxivId?: string | null
  article_external_id?: string | null
  article_id?: string
  article_title?: string | null
  articleExternalId?: string | null
  articleCreatedAt?: unknown
  articleId?: string
  articleTitle?: string | null
  article_updated_at?: unknown
  articleUpdatedAt?: unknown
  biorxiv_id?: string | null
  biorxivId?: string | null
  canonical_article_id?: string | null
  canonicalArticleId?: string | null
  doi?: string | null
  full_text_pdf?: string | null
  full_text_fetched_at?: unknown
  full_text_conversion_status?: string | null
  fullTextConversionStatus?: string | null
  fullTextFetchedAt?: unknown
  fullTextPDF?: string | null
  journal_title?: string | null
  journalTitle?: string | null
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
type ReviewServingReviewMode = 'both' | 'human' | 'unassessed'
type ReviewServingRouteDependencies = {
  currentReviewConfigHash?: string | null
  database?: ReviewServingReaderDatabase
  manifestDatabase?: ReviewServingManifestRepositoryDatabase
}
type HumanReviewArticlesResponse = {
  data: unknown[]
  humanJudgmentMode: 'prompt' | 'summary'
  limit: number
  nextCursor?: string | null
  page: number
  totalCount: number
  totalPages: number
}
type UnassessedReviewArticlesResponse = {
  data: unknown[]
  limit: number
  nextCursor?: string | null
  page: number
  totalCount: number
  totalPages: number
}
type ReviewServingRowsPageInput = {
  dependencies?: ReviewServingRouteDependencies
  label: string
  limit: number
  request: Omit<ReviewServingReaderRequest, 'contractKey'> & {contractKey: string}
}

const maxReviewPageSize = 500
const defaultReviewLimit = 100
const dynamicFilterKey = 'filter:dynamic'
const listAllFilterKey = 'list:all'
const maxJudgmentHydrationArticleIds = 100
const queueReadyFilterKey = 'queue:ready'

const getDateValue = (value: unknown) => {
  if (value instanceof Date) {
    return value
  }

  return typeof value === 'string' || typeof value === 'number' ? new Date(value) : null
}

const getJsonValue = (value: unknown) => {
  return typeof value === 'string' ? (JSON.parse(value) as unknown) : value
}

const getPayloadString = (value: unknown) => {
  return typeof value === 'string' ? value : ''
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

const getSearchTokenPrefixes = (search: string | null | undefined) => {
  return getReviewServingTitleSearchTokens(search ?? null)
}

const getSearchTokenPrefix = (search: string | null | undefined) => {
  return getSearchTokenPrefixes(search)[0] ?? null
}

const getRouteFilters = (params: ArticlesReviewsBothParams | ArticlesReviewsParams, mode: ReviewServingReviewMode) => {
  const promptAnswer = getPromptAnswerFilters(params.prompts)
  const searchTokenPrefixes = getSearchTokenPrefixes(params.search)

  return {
    ...(params.from ? {articleCreatedAtFrom: params.from} : {}),
    ...(params.to ? {articleCreatedAtTo: params.to} : {}),
    ...(params.hasDuplicateStudyRecords ? {duplicateFlag: 'true'} : {}),
    ...(params.hasStudyDecisionConflict ? {conflictFlag: 'true'} : {}),
    ...(mode === 'both' ? {llmStatus: 'complete'} : {}),
    ...(mode === 'human' || mode === 'both' ? {humanStatus: 'answered'} : {}),
    ...(mode === 'unassessed' ? {queueKind: 'unassessed'} : {}),
    ...(promptAnswer.length > 0 ? {promptAnswer} : {}),
    ...(searchTokenPrefixes.length > 0 ? {searchTokenPrefix: searchTokenPrefixes[0]} : {}),
  }
}

const getParamsWithEffectiveDateFilters = async <T extends ArticlesReviewsBothParams | ArticlesReviewsParams>(
  params: T,
  database: ReviewServingReaderDatabase,
) => {
  const dates = await getEffectiveReviewServingDateFilters(params, database)

  return {...params, from: dates.from, to: dates.to}
}

const hasDynamicFilters = (
  params: ArticlesReviewsBothParams | ArticlesReviewsParams,
  mode: ReviewServingReviewMode,
) => {
  const filters = getRouteFilters(params, mode)
  const filterKeys = Object.keys(filters)

  return mode === 'unassessed'
    ? filterKeys.some((key) => {
        return key !== 'queueKind'
      })
    : filterKeys.length > 0
}

const getManifest = async (projectId: string, dependencies?: ReviewServingRouteDependencies) => {
  const manifestDatabase =
    dependencies?.manifestDatabase ?? (getAppDatabaseService() as ReviewServingManifestRepositoryDatabase)
  const reviewConfigHash = dependencies?.currentReviewConfigHash ?? (await getCurrentReviewConfigHash(projectId))
  const active = await getActiveReviewServingSnapshotManifest({projectId, reviewConfigHash}, manifestDatabase)

  return active ?? getLastKnownGoodReviewServingSnapshotManifest({projectId, reviewConfigHash}, manifestDatabase)
}

const getReaderDependencies = (dependencies?: ReviewServingRouteDependencies) => {
  return {
    ...(dependencies?.database ? {database: dependencies.database} : {}),
    ...(dependencies?.manifestDatabase
      ? {diagnosticsDatabase: dependencies.manifestDatabase, manifestDatabase: dependencies.manifestDatabase}
      : {}),
  }
}

const getBaseReaderRequest = (
  params: ArticlesReviewsBothParams | ArticlesReviewsParams,
  manifest: ReviewServingSnapshotManifest,
  limit: number,
  mode: ReviewServingReviewMode,
): Omit<ReviewServingReaderRequest, 'contractKey'> => {
  const searchTokenPrefix = getSearchTokenPrefix(params.search)

  return {
    allowStale: true,
    filters: getRouteFilters(params, mode),
    limit,
    listMode: mode,
    projectId: params.projectId,
    queueKind: mode === 'unassessed' ? 'unassessed' : null,
    reviewConfigHash: manifest.reviewConfigHash,
    searchMode: searchTokenPrefix ? 'tokenPrefix' : 'none',
    searchState: searchTokenPrefix ? {availability: 'ready', snapshotId: manifest.snapshotId} : null,
    searchTokenPrefix,
    searchTokenPrefixes: getSearchTokenPrefixes(params.search),
    snapshotId: manifest.snapshotId,
  }
}

const getCountState = (
  params: ArticlesReviewsBothParams | ArticlesReviewsParams,
  manifest: ReviewServingSnapshotManifest,
  mode: ReviewServingReviewMode,
) => {
  const filterKey = hasDynamicFilters(params, mode)
    ? dynamicFilterKey
    : mode === 'unassessed'
      ? queueReadyFilterKey
      : listAllFilterKey
  const key: NamedReviewFastCountKey = hasDynamicFilters(params, mode)
    ? 'review.list.filteredTotal'
    : mode === 'unassessed'
      ? 'review.queue.unassessedReady'
      : 'review.list.total'

  return {availability: 'ready' as const, filterKey, key, snapshotId: manifest.snapshotId, value: 0}
}

const getResponsePage = (params: ArticlesReviewsBothParams | ArticlesReviewsParams) => {
  return 'cursor' in params && params.cursor ? getPage(params.page) : 1
}

const isLlmPlaceholderRow = (row: ReviewServingJudgmentRow) => {
  return (row.placeholder_kind ?? row.placeholderKind ?? null) !== null
}

const getCountValue = async (
  params: ArticlesReviewsBothParams | ArticlesReviewsParams,
  manifest: ReviewServingSnapshotManifest,
  mode: ReviewServingReviewMode,
  dependencies?: ReviewServingRouteDependencies,
) => {
  if (hasDynamicFilters(params, mode)) {
    return getFilteredCountValue(params, manifest, mode, dependencies)
  }

  const countState = getCountState(params, manifest, mode)
  const result = await readReviewServingRows<ReviewServingCountRow>(
    {
      ...getBaseReaderRequest(params, manifest, 1, mode),
      contractKey:
        mode === 'unassessed'
          ? 'review.unassessed.count'
          : mode === 'both'
            ? 'review.both.count'
            : 'review.human.count',
      countFilterKey: countState.filterKey,
      countState,
      limit: 1,
      namedCountKey: countState.key,
      searchMode: 'none',
      searchState: null,
      searchTokenPrefix: null,
    },
    getReaderDependencies(dependencies),
  )

  if (result.status === 'rejected') {
    throw new Error(`reviewServingReader rejected ${mode} review count: ${result.reason}`)
  }

  const countRow = result.rows[0]

  if (countRow?.availability === 'unavailable') {
    throw new Error(countRow.stale_reason ?? 'Review count is unavailable for the requested filter scope')
  }

  return Number(countRow?.count_value ?? countRow?.countValue ?? 0)
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

const getPromptAnswerPredicates = (
  params: ArticlesReviewsBothParams | ArticlesReviewsParams,
  mode: ReviewServingReviewMode,
) => {
  const promptPrefix = mode === 'human' ? 'human:promptAnswer:' : 'review:promptAnswer:'

  return Object.entries(params.prompts ?? {})
    .filter(([, values]) => {
      return values.length > 0
    })
    .map(([promptId, values], index) => {
      const filterValues = values.map((value) => {
        return `${promptPrefix}${promptId}:${value}`
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

const getManifestComponentIdentity = (manifest: ReviewServingSnapshotManifest, component: string) => {
  return [...manifest.componentState.required, ...manifest.componentState.optional].find((entry) => {
    return entry.component === component
  })?.projectionIdentity
}

const getSearchPredicate = (
  params: ArticlesReviewsBothParams | ArticlesReviewsParams,
  filters: ReturnType<typeof getRouteFilters>,
  manifest: ReviewServingSnapshotManifest,
) => {
  const searchTokenPrefixes = filters.searchTokenPrefix ? getSearchTokenPrefixes(params.search) : []

  return searchTokenPrefixes.length > 0
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
}

const getUnassessedQueuePredicate = (mode: ReviewServingReviewMode) => {
  return mode === 'unassessed'
    ? `AND EXISTS (
        SELECT 1
        FROM mart.review_unassessed_queue_serving_v4 queue
        WHERE queue.project_id = serving.project_id
          AND queue.review_config_hash IS NOT DISTINCT FROM serving.review_config_hash
          AND queue.snapshot_id = serving.snapshot_id
          AND queue.queue_kind = 'unassessed'
          AND queue.article_id = serving.article_id
      )`
    : ''
}

const getFilteredCountValue = async (
  params: ArticlesReviewsBothParams | ArticlesReviewsParams,
  manifest: ReviewServingSnapshotManifest,
  mode: ReviewServingReviewMode,
  dependencies?: ReviewServingRouteDependencies,
) => {
  const database = dependencies?.database ?? (getAppDatabaseService() as ReviewServingReaderDatabase)
  const filters = getRouteFilters(params, mode)
  const llmStatusValue = filters.llmStatus === 'complete' ? 'answered' : null
  const [row] = await database.queryJson<{totalCount: number}>(`
    SELECT COUNT(DISTINCT serving.article_id) AS totalCount
    FROM mart.review_article_serving_v4 serving
    WHERE serving.project_id = ${getSqlLiteral(params.projectId)}
      AND serving.review_config_hash = ${getSqlLiteral(manifest.reviewConfigHash)}
      AND serving.snapshot_id = ${getSqlLiteral(manifest.snapshotId)}
      AND serving.list_mode_key = ${getSqlLiteral(mode)}
      ${getUnassessedQueuePredicate(mode)}
      ${filters.articleCreatedAtFrom ? `AND serving.article_created_at >= TIMESTAMPTZ ${getSqlLiteral(filters.articleCreatedAtFrom)}` : ''}
      ${getDateToPredicate('serving.article_created_at', filters.articleCreatedAtTo)}
      ${filters.duplicateFlag ? 'AND serving.duplicate_flag = TRUE' : ''}
      ${filters.conflictFlag ? 'AND serving.conflict_flag = TRUE' : ''}
      ${llmStatusValue ? `AND serving.llm_status_key = ${getSqlLiteral(llmStatusValue)}` : ''}
      ${typeof filters.humanStatus === 'string' ? `AND serving.human_status_key = ${getSqlLiteral(filters.humanStatus)}` : ''}
      ${getPromptAnswerPredicates(params, mode).join('\n')}
      ${getSearchPredicate(params, filters, manifest)}
  `)

  return Number(row?.totalCount ?? 0)
}

const getArticleId = (row: ReviewServingArticleRow) => {
  return row.article_id ?? row.articleId ?? ''
}

const getJudgmentPayload = (row: ReviewServingJudgmentRow) => {
  return getJsonValue(row.judgment_payload_json ?? null) as Record<string, unknown> | null
}

const getLlmJudgmentsByArticleId = (rows: readonly ReviewServingJudgmentRow[]) => {
  return rows
    .filter((row) => {
      return !isLlmPlaceholderRow(row)
    })
    .reduce((acc, row) => {
      const articleId = row.article_id ?? ''
      const payload = getJudgmentPayload(row)
      const judgment = {
        id: row.judgment_id ?? getPayloadString(payload?.id),
        createdAt: getPayloadString(payload?.createdAt) || getPayloadString(row.detail_updated_at),
        articleId,
        promptId: row.prompt_id ?? '',
        modelId: row.model_id ?? getPayloadString(payload?.modelId),
        answeredOriginal: row.answered_original ?? (payload?.answeredOriginal as string | null) ?? null,
        answeredOriginalAsArray: row.answered_original_as_array ?? [],
        explanation: (payload?.explanation as string | null) ?? null,
        quotes: payload?.quotes ?? null,
      }
      const existing = acc.get(articleId) ?? []

      return acc.set(articleId, [...existing, judgment])
    }, new Map<string, ArticlesReviewsBothResponse['data'][number]['judgments']>())
}

const getHumanJudgmentsByArticleId = (rows: readonly ReviewServingJudgmentRow[]) => {
  return rows.reduce((acc, row) => {
    const articleId = row.article_id ?? ''
    const payload = getJudgmentPayload(row)
    const judgment = {
      id: row.judgment_id ?? getPayloadString(payload?.id),
      createdAt: getDateValue(payload?.createdAt ?? row.detail_updated_at),
      updatedAt: getDateValue(payload?.updatedAt ?? row.detail_updated_at),
      articleId,
      promptId: row.prompt_id ?? '',
      isAnswered: Boolean(payload?.isAnswered ?? row.answered_original),
      answer: row.answered_original ?? (payload?.answer as string | null) ?? null,
      comment: (payload?.comment as string | null) ?? null,
      projectId: '',
    }
    const existing = acc.get(articleId) ?? []

    return acc.set(articleId, [...existing, judgment])
  }, new Map<string, {answer: string | null; articleId: string; comment: string | null; createdAt: Date | null; id: string; isAnswered: boolean; projectId: string; promptId: string; updatedAt: Date | null}[]>())
}

const getHumanAnswersByPrompt = (judgments: readonly {answer: string | null; promptId: string}[]) => {
  return judgments.reduce<Record<string, string[]>>((acc, judgment) => {
    return judgment.answer === null
      ? acc
      : {...acc, [judgment.promptId]: [...(acc[judgment.promptId] ?? []), judgment.answer]}
  }, {})
}

const getSummaryAnswer = (value: string | null | undefined): 'maybe' | 'no' | 'yes' | null => {
  return value === 'yes' || value === 'no' || value === 'maybe' ? value : null
}

const getLlmSummaryAnswer = (
  judgments: ArticlesReviewsBothResponse['data'][number]['judgments'],
): 'maybe' | 'no' | 'yes' | null => {
  const answers = judgments
    .map((judgment) => {
      return normalizeSummaryAnswerValue(judgment.answeredOriginal)
    })
    .filter((answer): answer is 'maybe' | 'no' | 'yes' => {
      return answer !== null
    })

  return answers.length === 0 ? null : answers.includes('no') ? 'no' : answers.includes('maybe') ? 'maybe' : 'yes'
}

const getArticleIdChunks = (articleIds: readonly string[]) => {
  return articleIds.reduce<string[][]>((chunks, articleId, index) => {
    return index % maxJudgmentHydrationArticleIds === 0
      ? [...chunks, [articleId]]
      : chunks.map((chunk, chunkIndex) => {
          return chunkIndex === chunks.length - 1 ? [...chunk, articleId] : chunk
        })
  }, [])
}

const readJudgmentChunk = async (
  params: ArticlesReviewsBothParams | ArticlesReviewsParams,
  manifest: ReviewServingSnapshotManifest,
  mode: 'both' | 'human',
  articleIds: readonly string[],
  kind: 'human' | 'llm',
  dependencies?: ReviewServingRouteDependencies,
) => {
  return readReviewServingRows<ReviewServingJudgmentRow>(
    {
      ...getBaseReaderRequest(params, manifest, Math.min(articleIds.length * 128, 10_000), mode),
      articleIds,
      contractKey:
        mode === 'both'
          ? kind === 'human'
            ? 'review.both.list.humanJudgments'
            : 'review.both.list.judgments'
          : 'review.human.list.judgments',
      estimatedHydratedPayloadBytes: articleIds.length * 10_000,
      estimatedResultBytes: articleIds.length * 20_000,
      filters: {},
      limit: Math.min(articleIds.length * 128, 10_000),
      searchMode: 'none',
      searchState: null,
      searchTokenPrefix: null,
    },
    getReaderDependencies(dependencies),
  ).then((result) => {
    if (result.status === 'rejected') {
      throw new Error(`reviewServingReader rejected ${mode} ${kind} judgments: ${result.reason}`)
    }

    return result.rows
  })
}

const readJudgments = async (
  params: ArticlesReviewsBothParams | ArticlesReviewsParams,
  manifest: ReviewServingSnapshotManifest,
  mode: 'both' | 'human',
  articleIds: readonly string[],
  kind: 'human' | 'llm',
  dependencies?: ReviewServingRouteDependencies,
) => {
  return articleIds.length === 0
    ? []
    : Promise.all(
        getArticleIdChunks(articleIds).map((chunk) => {
          return readJudgmentChunk(params, manifest, mode, chunk, kind, dependencies)
        }),
      ).then((chunks) => {
        return chunks.flat()
      })
}

const readRowsPage = async <T>(input: ReviewServingRowsPageInput): Promise<{nextCursor: string | null; rows: T[]}> => {
  const rowsResult = await readReviewServingRows<T>(input.request, getReaderDependencies(input.dependencies))

  if (rowsResult.status === 'rejected') {
    throw new Error(`reviewServingReader rejected ${input.label}: ${rowsResult.reason}`)
  }

  const rows = rowsResult.rows.slice(0, input.limit)
  const lastRow = rows[rows.length - 1]
  const nextCursor =
    rowsResult.rows.length > input.limit && lastRow
      ? rowsResult.getCursorForRow(lastRow as Record<string, unknown>)
      : null

  return {nextCursor, rows}
}

const getArticleResponseBase = (row: ReviewServingArticleRow) => {
  return {
    id: getArticleId(row),
    articleTitle: row.article_title ?? row.articleTitle ?? null,
    articleCreatedAt: getDateValue(row.article_created_at ?? row.articleCreatedAt),
    articleUpdatedAt: getDateValue(row.article_updated_at ?? row.articleUpdatedAt),
    articleId: row.article_external_id ?? row.articleExternalId ?? null,
    arxivId: row.arxiv_id ?? row.arxivId ?? null,
    biorxivId: row.biorxiv_id ?? row.biorxivId ?? null,
    canonicalArticleId: row.canonical_article_id ?? row.canonicalArticleId ?? null,
    doi: row.doi ?? null,
    fullTextConversionStatus: row.full_text_conversion_status ?? row.fullTextConversionStatus ?? null,
    fullTextFetchedAt: getDateValue(row.full_text_fetched_at ?? row.fullTextFetchedAt),
    fullTextPDF: row.full_text_pdf ?? row.fullTextPDF ?? null,
    journalTitle: row.journal_title ?? row.journalTitle ?? null,
    medrxivId: row.medrxiv_id ?? row.medrxivId ?? null,
    originalData: row.original_data ?? row.originalData ?? null,
    pubmedId: row.pmid ?? null,
    selectedImportRouteId: row.selected_import_route_id ?? row.selectedImportRouteId ?? null,
    sourceMetadata: row.source_metadata ?? row.sourceMetadata ?? null,
    url: row.url ?? null,
  }
}

export const getHumanReviewArticlesFromServing = async (
  params: ArticlesReviewsParams,
  dependencies?: ReviewServingRouteDependencies,
): Promise<HumanReviewArticlesResponse> => {
  const database = dependencies?.database ?? (getAppDatabaseService() as ReviewServingReaderDatabase)
  const effectiveParams = await getParamsWithEffectiveDateFilters(params, database)
  const manifest = await getManifest(params.projectId, dependencies)
  const page = getResponsePage(effectiveParams)
  const limit = getLimit(effectiveParams.limit)

  if (!manifest) {
    throw new Error('Review serving snapshot is unavailable')
  }

  const pageResult = await readRowsPage<ReviewServingArticleRow>({
    dependencies,
    label: 'human review rows',
    limit,
    request: {
      ...getBaseReaderRequest(effectiveParams, manifest, limit + 1, 'human'),
      contractKey: 'review.human.rows',
      cursor: effectiveParams.cursor ?? null,
    },
  })
  const pageRows = pageResult.rows

  const articleIds = pageRows.map(getArticleId)
  const humanRows = await readJudgments(effectiveParams, manifest, 'human', articleIds, 'human', dependencies)
  const judgmentsByArticleId = getHumanJudgmentsByArticleId(humanRows)
  const totalCount = await getCountValue(effectiveParams, manifest, 'human', {...dependencies, database})
  const data = pageRows.map((row) => {
    const judgments = judgmentsByArticleId.get(getArticleId(row)) ?? []
    const summaryJudgment = judgments.find((judgment) => {
      return judgment.promptId === 'summary'
    })

    return {
      ...getArticleResponseBase(row),
      humanJudgmentMode: summaryJudgment ? ('summary' as const) : ('prompt' as const),
      humanSummaryAnswer: summaryJudgment?.answer ?? null,
      judgments,
      judgedPromptIds: judgments.map((judgment) => {
        return judgment.promptId
      }),
      isFullyJudged: true,
    }
  })

  return {
    data,
    humanJudgmentMode: data[0]?.humanJudgmentMode ?? 'prompt',
    totalCount,
    page,
    limit,
    totalPages: Math.ceil(totalCount / limit),
    nextCursor: pageResult.nextCursor,
  }
}

export const getBothReviewArticlesFromServing = async (
  params: ArticlesReviewsBothParams,
  dependencies?: ReviewServingRouteDependencies,
): Promise<ArticlesReviewsBothResponse> => {
  const database = dependencies?.database ?? (getAppDatabaseService() as ReviewServingReaderDatabase)
  const effectiveParams = await getParamsWithEffectiveDateFilters(params, database)
  const manifest = await getManifest(params.projectId, dependencies)
  const page = getResponsePage(effectiveParams)
  const limit = getLimit(effectiveParams.limit)

  if (!manifest) {
    throw new Error('Review serving snapshot is unavailable')
  }

  const pageResult = await readRowsPage<ReviewServingArticleRow>({
    dependencies,
    label: 'both review rows',
    limit,
    request: {
      ...getBaseReaderRequest(effectiveParams, manifest, limit + 1, 'both'),
      contractKey: 'review.both.rows',
      cursor: effectiveParams.cursor ?? null,
    },
  })
  const pageRows = pageResult.rows

  const articleIds = pageRows.map(getArticleId)
  const [llmRows, humanRows] = await Promise.all([
    readJudgments(effectiveParams, manifest, 'both', articleIds, 'llm', dependencies),
    readJudgments(effectiveParams, manifest, 'both', articleIds, 'human', dependencies),
  ])
  const llmJudgmentsByArticleId = getLlmJudgmentsByArticleId(llmRows)
  const humanJudgmentsByArticleId = getHumanJudgmentsByArticleId(humanRows)
  const totalCount = await getCountValue(effectiveParams, manifest, 'both', {...dependencies, database})
  const data = pageRows.map((row) => {
    const articleId = getArticleId(row)
    const humanJudgments = humanJudgmentsByArticleId.get(articleId) ?? []
    const summaryJudgment = humanJudgments.find((judgment) => {
      return judgment.promptId === 'summary'
    })
    const judgments = llmJudgmentsByArticleId.get(articleId) ?? []

    return {
      ...getArticleResponseBase(row),
      judgments,
      humanJudgmentMode: summaryJudgment ? ('summary' as const) : ('prompt' as const),
      humanSummaryAnswer: getSummaryAnswer(summaryJudgment?.answer),
      llmSummaryAnswer: getLlmSummaryAnswer(judgments),
      ...(summaryJudgment ? {} : {humanAnswersByPrompt: getHumanAnswersByPrompt(humanJudgments)}),
    }
  })

  return {data, totalCount, page, limit, totalPages: Math.ceil(totalCount / limit), nextCursor: pageResult.nextCursor}
}

export const getUnassessedReviewArticlesFromServing = async (
  params: ArticlesReviewsParams,
  dependencies?: ReviewServingRouteDependencies,
): Promise<UnassessedReviewArticlesResponse> => {
  const database = dependencies?.database ?? (getAppDatabaseService() as ReviewServingReaderDatabase)
  const effectiveParams = await getParamsWithEffectiveDateFilters(params, database)
  const manifest = await getManifest(params.projectId, dependencies)
  const page = getResponsePage(effectiveParams)
  const limit = getLimit(effectiveParams.limit)

  if (!manifest) {
    throw new Error('Review serving snapshot is unavailable')
  }

  const pageResult = await readRowsPage<ReviewServingArticleRow>({
    dependencies,
    label: 'unassessed article rows',
    limit,
    request: {
      ...getBaseReaderRequest(effectiveParams, manifest, limit + 1, 'unassessed'),
      contractKey: 'review.unassessed.rows',
      cursor: effectiveParams.cursor ?? null,
    },
  })
  const pageRows = pageResult.rows
  const totalCount = await getCountValue(effectiveParams, manifest, 'unassessed', {...dependencies, database})
  const data = pageRows.map((row) => {
    return {...getArticleResponseBase(row), judgments: [], judgedPromptIds: [], isFullyJudged: false}
  })

  return {data, totalCount, page, limit, totalPages: Math.ceil(totalCount / limit), nextCursor: pageResult.nextCursor}
}
