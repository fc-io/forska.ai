import type {ProjectPromptCriteriaDisposition} from '../../db/schemaTypes.ts'
import type {
  ArticlesReviewsBothParams,
  ArticlesReviewsBothResponse,
  ArticlesReviewsParams,
  ReviewDetailReadiness,
} from '../../services/olap/olapTypes.ts'
import {getAppDatabaseService} from '../services/appDatabaseService.ts'
import {getSqlLiteral} from '../services/appQueryHelpers.ts'
import {getCurrentReviewConfigHash} from '../services/reviewServingProjectConfigIdentity.ts'
import {deriveStrictSummaryAnswer, getNormalizedSummaryAnswer} from '../utils/judgmentAnswers.ts'
import type {NamedReviewFastCountKey} from './reviewServingContracts.ts'
import {
  getReviewServingDynamicFilteredCountSql,
  type ReviewServingDynamicCountPostingFilterGroup,
} from './reviewServingDynamicCountSql.ts'
import {
  getReviewServingFilteredCountComponentIdentities,
  getReviewServingFilteredCountSignature,
  getReviewServingFilteredCountValue,
  type ReviewServingFilteredCountDatabase,
} from './reviewServingFilteredCountService.ts'
import {
  ensureReviewServingLazyPromptAnswerPostingBuckets,
  type ReviewServingLazyPromptAnswerPostingDatabase,
} from './reviewServingLazyPromptAnswerPostingSql.ts'
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
  explanation?: string | null
  human_comment?: string | null
  judgment_created_at?: unknown
  judgment_id?: string | null
  judgment_model_id?: string | null
  placeholder_kind?: string | null
  placeholderKind?: string | null
  prompt_criteria_disposition?: ProjectPromptCriteriaDisposition | null
  prompt_id?: string
  quotes?: unknown
}

type BothLlmJudgmentWithCriteria = ArticlesReviewsBothResponse['data'][number]['judgments'][number] & {
  criteriaDisposition: ProjectPromptCriteriaDisposition | null
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
  detailReadiness?: ReviewDetailReadiness
  error?: string
  humanJudgmentMode: 'prompt' | 'summary'
  limit: number
  nextCursor?: string | null
  page: number
  totalCount: number
  totalPages: number
}
type UnassessedReviewArticlesResponse = {
  data: unknown[]
  error?: string
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
type ReviewServingRowsPageResult<T> = {detailReadiness: ReviewDetailReadiness; nextCursor: string | null; rows: T[]}
type PromptAnswerFilterGroup = {filterValues: string[]}

const maxReviewPageSize = 500
const defaultReviewLimit = 100
const dynamicFilterKey = 'filter:dynamic'
const listAllFilterKey = 'list:all'
const maxJudgmentHydrationArticleIds = 100
const maxJudgmentHydrationRows = 10_000
const defaultJudgmentHydrationPromptCount = 128
const queueReadyFilterKey = 'queue:ready'
const reviewServingSnapshotUnavailableError = 'Review serving snapshot is unavailable'
const routeReadMaxAttempts = 4
const routeReadRetryDelaysMs = [100, 250, 500] as const
type ReviewServingRouteReadContext = Parameters<ReviewServingReaderDatabase['queryJson']>[1]

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

const promptAnswerFilterValuePrefixPattern = /^(?:human|review):promptAnswer:/

const getQualifiedPromptAnswerFilterValue = (promptId: string, value: string, prefix: string) => {
  const promptValue = `${promptId}:${value}`

  return promptAnswerFilterValuePrefixPattern.test(promptValue) ? promptValue : `${prefix}${promptValue}`
}

const getPromptAnswerFilterGroups = (
  prompts: Record<string, string[]> | undefined,
  mode: ReviewServingReviewMode,
): PromptAnswerFilterGroup[] => {
  const promptPrefix = mode === 'human' ? 'human:promptAnswer:' : 'review:promptAnswer:'

  return Object.entries(prompts ?? {})
    .filter(([, values]) => {
      return values.length > 0
    })
    .sort(([leftPromptId], [rightPromptId]) => {
      return leftPromptId.localeCompare(rightPromptId)
    })
    .map(([promptId, values]) => {
      return {
        filterValues: [...values]
          .sort((leftValue, rightValue) => {
            return leftValue.localeCompare(rightValue)
          })
          .map((value) => {
            return getQualifiedPromptAnswerFilterValue(promptId, value, promptPrefix)
          }),
      }
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
    ...(dependencies?.database
      ? {lazyPromptAnswerPostingDatabase: dependencies.database as ReviewServingLazyPromptAnswerPostingDatabase}
      : {}),
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
): Promise<number> => {
  if (mode === 'unassessed' || hasDynamicFilters(params, mode)) {
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

const getPromptAnswerPostingFilterGroups = (
  params: ArticlesReviewsBothParams | ArticlesReviewsParams,
  mode: ReviewServingReviewMode,
): ReviewServingDynamicCountPostingFilterGroup[] => {
  return getPromptAnswerFilterGroups(params.prompts, mode).map((group) => {
    return {filterKind: 'promptAnswer', filterValues: group.filterValues}
  })
}

const getFlagPostingFilterGroups = (filters: ReturnType<typeof getRouteFilters>) => {
  return [
    {filterKind: 'duplicateFlag', enabled: Boolean(filters.duplicateFlag)},
    {filterKind: 'conflictFlag', enabled: Boolean(filters.conflictFlag)},
  ]
    .filter((filter) => {
      return filter.enabled
    })
    .map((filter) => {
      return {filterKind: filter.filterKind, filterValues: ['true']}
    })
}

const getStatusPostingFilterGroups = (filters: ReturnType<typeof getRouteFilters>) => {
  const llmStatusValue = filters.llmStatus === 'complete' ? 'answered' : null
  const humanStatusValue = typeof filters.humanStatus === 'string' ? filters.humanStatus : null

  return [
    {filterKind: 'llmStatus', filterValues: llmStatusValue ? [llmStatusValue] : []},
    {filterKind: 'humanStatus', filterValues: humanStatusValue ? [humanStatusValue] : []},
  ].filter((filter) => {
    return filter.filterValues.length > 0
  })
}

const getManifestComponentIdentity = (manifest: ReviewServingSnapshotManifest, component: string) => {
  return [...manifest.componentState.required, ...manifest.componentState.optional].find((entry) => {
    return entry.component === component
  })?.projectionIdentity
}

const sleep = (delayMs: number) => {
  return new Promise((resolve) => {
    setTimeout(resolve, delayMs)
  })
}

const isTransientRouteReadError = (error: unknown) => {
  const message = error instanceof Error ? error.message : String(error)

  return message.includes('An unknown error occurred in Effect.tryPromise')
}

const queryRouteRowsWithRetry = async <T>(
  database: ReviewServingReaderDatabase,
  statement: string,
  workloadContext?: ReviewServingRouteReadContext,
  attempt = 0,
): Promise<T[]> => {
  try {
    return await database.queryJson<T>(statement, workloadContext)
  } catch (error) {
    if (!isTransientRouteReadError(error) || attempt >= routeReadMaxAttempts - 1) {
      throw error
    }

    await sleep(routeReadRetryDelaysMs[attempt] ?? routeReadRetryDelaysMs[routeReadRetryDelaysMs.length - 1])

    return queryRouteRowsWithRetry<T>(database, statement, workloadContext, attempt + 1)
  }
}

const createRetryingRouteDatabase = (database: ReviewServingReaderDatabase): ReviewServingReaderDatabase => {
  return {
    queryJson: async <T>(statement: string, workloadContext?: ReviewServingRouteReadContext) => {
      return queryRouteRowsWithRetry<T>(database, statement, workloadContext)
    },
  }
}

const getRouteDatabase = (dependencies?: ReviewServingRouteDependencies) => {
  return createRetryingRouteDatabase(dependencies?.database ?? (getAppDatabaseService() as ReviewServingReaderDatabase))
}

const getFilteredCountValue = async (
  params: ArticlesReviewsBothParams | ArticlesReviewsParams,
  manifest: ReviewServingSnapshotManifest,
  mode: ReviewServingReviewMode,
  dependencies?: ReviewServingRouteDependencies,
): Promise<number> => {
  const database = dependencies?.database ?? (getAppDatabaseService() as ReviewServingFilteredCountDatabase)
  const filters = getRouteFilters(params, mode)
  const promptAnswerPostingFilterGroups = getPromptAnswerPostingFilterGroups(params, mode)
  const searchTokenPrefixes = filters.searchTokenPrefix ? getSearchTokenPrefixes(params.search) : []

  return getReviewServingFilteredCountValue({
    ...getReviewServingFilteredCountComponentIdentities(
      manifest,
      mode === 'both'
        ? ['display', 'projectScope', 'selectedImport', 'llmStatus', 'humanStatus', 'posting', 'search']
        : mode === 'human'
          ? ['display', 'projectScope', 'selectedImport', 'humanStatus', 'posting', 'search']
          : ['display', 'projectScope', 'selectedImport', 'queue', 'posting', 'search'],
    ),
    computeCount: async () => {
      const promptAnswerFilterValues = promptAnswerPostingFilterGroups.flatMap((group) => {
        return group.filterValues
      })
      let useCanonicalPromptAnswerPostings = false

      if (promptAnswerFilterValues.length > 0) {
        try {
          await ensureReviewServingLazyPromptAnswerPostingBuckets({
            database,
            filterValues: promptAnswerFilterValues,
            listModeKey: mode,
            projectId: params.projectId,
            reviewConfigHash: manifest.reviewConfigHash,
            snapshotId: manifest.snapshotId,
          })
        } catch (_error) {
          useCanonicalPromptAnswerPostings = true
        }
      }

      const [row] = await queryRouteRowsWithRetry<{totalCount: number}>(
        database,
        `
        ${getReviewServingDynamicFilteredCountSql({
          includeUnassessedQueue: mode === 'unassessed',
          listModeKey: mode,
          postingFilterGroups: [
            ...promptAnswerPostingFilterGroups,
            ...getFlagPostingFilterGroups(filters),
            ...getStatusPostingFilterGroups(filters),
          ],
          projectId: params.projectId,
          projectScopeIdentity: getManifestComponentIdentity(manifest, 'projectScope') ?? '',
          reviewConfigHash: manifest.reviewConfigHash,
          searchIdentity: getManifestComponentIdentity(manifest, 'search') ?? '',
          searchTokenPrefixes,
          servingPredicates: [
            filters.articleCreatedAtFrom
              ? `AND serving.article_created_at >= TIMESTAMPTZ ${getSqlLiteral(filters.articleCreatedAtFrom)}`
              : '',
            getDateToPredicate('serving.article_created_at', filters.articleCreatedAtTo),
          ],
          snapshotId: manifest.snapshotId,
          useCanonicalPromptAnswerPostings,
        })}
      `,
      )

      return Number(row?.totalCount ?? 0)
    },
    database,
    filterSignature: getReviewServingFilteredCountSignature({filters, searchTokenPrefixes}),
    listModeKey: mode,
    projectId: params.projectId,
    reviewConfigHash: manifest.reviewConfigHash,
    snapshotId: manifest.snapshotId,
  })
}

const getArticleId = (row: ReviewServingArticleRow) => {
  return row.article_id ?? row.articleId ?? ''
}

const getLlmJudgmentsByArticleId = (rows: readonly ReviewServingJudgmentRow[]) => {
  return rows
    .filter((row) => {
      return !isLlmPlaceholderRow(row)
    })
    .reduce((acc, row) => {
      const articleId = row.article_id ?? ''
      const judgment = {
        id: row.judgment_id ?? '',
        createdAt: getPayloadString(row.judgment_created_at) || getPayloadString(row.detail_updated_at),
        articleId,
        promptId: row.prompt_id ?? '',
        modelId: row.judgment_model_id ?? '',
        answeredOriginal: row.answered_original ?? null,
        answeredOriginalAsArray: row.answered_original_as_array ?? [],
        criteriaDisposition: row.prompt_criteria_disposition ?? null,
        explanation: row.explanation ?? null,
        quotes: getJsonValue(row.quotes ?? null),
      }
      const existing = acc.get(articleId) ?? []

      return acc.set(articleId, [...existing, judgment])
    }, new Map<string, BothLlmJudgmentWithCriteria[]>())
}

const getHumanJudgmentsByArticleId = (rows: readonly ReviewServingJudgmentRow[]) => {
  return rows.reduce((acc, row) => {
    const articleId = row.article_id ?? ''
    const judgment = {
      id: row.judgment_id ?? '',
      createdAt: getDateValue(row.judgment_created_at ?? row.detail_updated_at),
      updatedAt: getDateValue(row.detail_updated_at),
      articleId,
      promptId: row.prompt_id ?? '',
      isAnswered: Boolean(row.answered_original),
      answer: row.answered_original ?? null,
      comment: row.human_comment ?? null,
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

const getLlmSummaryAnswer = (judgments: readonly BothLlmJudgmentWithCriteria[]): 'maybe' | 'no' | 'yes' | null => {
  const latestJudgmentByPrompt = judgments.reduce<Map<string, BothLlmJudgmentWithCriteria>>((acc, judgment) => {
    const existing = acc.get(judgment.promptId)

    return !existing || judgment.createdAt >= existing.createdAt ? acc.set(judgment.promptId, judgment) : acc
  }, new Map<string, BothLlmJudgmentWithCriteria>())
  const latestJudgments = Array.from(latestJudgmentByPrompt.values())

  return deriveStrictSummaryAnswer(
    latestJudgments.map((judgment) => {
      return {criteriaDisposition: judgment.criteriaDisposition, promptId: judgment.promptId}
    }),
    latestJudgments.reduce<Record<string, 'maybe' | 'no' | 'yes' | null>>((acc, judgment) => {
      return {...acc, [judgment.promptId]: getNormalizedSummaryAnswer(judgment)}
    }, {}),
    () => {},
  )
}

const withoutInternalLlmJudgmentFields = (
  judgments: readonly BothLlmJudgmentWithCriteria[],
): ArticlesReviewsBothResponse['data'][number]['judgments'] => {
  return judgments.map(({criteriaDisposition: _criteriaDisposition, ...judgment}) => {
    return judgment
  })
}

const getEnabledPromptCount = async (
  projectId: string,
  dependencies?: ReviewServingRouteDependencies,
): Promise<number> => {
  const database = dependencies?.database ?? (getAppDatabaseService() as ReviewServingReaderDatabase)
  const [row] = await database.queryJson<{promptCount?: number | null; prompt_count?: number | null}>(`
    SELECT COUNT(*)::INTEGER AS promptCount
    FROM app.project_prompt project_prompt
    INNER JOIN app.prompt prompt
      ON prompt.id = project_prompt.prompt_id
    WHERE project_prompt.project_id = ${getSqlLiteral(projectId)}
      AND project_prompt.enabled
      AND NOT project_prompt.archived
      AND COALESCE(prompt.archived, FALSE) = FALSE
  `)

  return Number(row?.promptCount ?? row?.prompt_count ?? 0)
}

const getJudgmentHydrationPromptCount = (enabledPromptCount: number) => {
  return enabledPromptCount > 0 ? enabledPromptCount : defaultJudgmentHydrationPromptCount
}

const getMaxJudgmentHydrationArticleIds = (promptCount: number) => {
  return Math.max(1, Math.min(maxJudgmentHydrationArticleIds, Math.floor(maxJudgmentHydrationRows / promptCount)))
}

const getArticleIdChunks = (articleIds: readonly string[], promptCount: number) => {
  const maxArticleIds = getMaxJudgmentHydrationArticleIds(promptCount)

  return articleIds.reduce<string[][]>((chunks, articleId, index) => {
    return index % maxArticleIds === 0
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
  promptCount: number,
  dependencies?: ReviewServingRouteDependencies,
) => {
  const limit = Math.min(articleIds.length * promptCount, maxJudgmentHydrationRows)

  return readReviewServingRows<ReviewServingJudgmentRow>(
    {
      ...getBaseReaderRequest(params, manifest, limit, mode),
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
      limit,
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
  rows: readonly ReviewServingArticleRow[],
  kind: 'human' | 'llm',
  enabledPromptCount: number,
  dependencies?: ReviewServingRouteDependencies,
) => {
  const articleIds = rows.map(getArticleId)
  const promptCount = getJudgmentHydrationPromptCount(enabledPromptCount)

  return articleIds.length === 0
    ? []
    : Promise.all(
        getArticleIdChunks(articleIds, promptCount).map((chunk) => {
          return readJudgmentChunk(params, manifest, mode, chunk, kind, promptCount, dependencies)
        }),
      ).then((chunks) => {
        return chunks.flat()
      })
}

const getResponseDetailReadiness = (value: string): ReviewDetailReadiness => {
  return value === 'ready' || value === 'indexing' ? value : 'unavailable'
}

const readRowsPage = async <T>(input: ReviewServingRowsPageInput): Promise<ReviewServingRowsPageResult<T>> => {
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

  return {
    detailReadiness: getResponseDetailReadiness(rowsResult.diagnostics.manifest.detailReadiness),
    nextCursor,
    rows,
  }
}

const getArticleResponseBase = (row: ReviewServingArticleRow, detailReadiness?: ReviewDetailReadiness) => {
  return {
    id: getArticleId(row),
    articleTitle: row.article_title ?? row.articleTitle ?? null,
    articleCreatedAt: getDateValue(row.article_created_at ?? row.articleCreatedAt),
    articleUpdatedAt: getDateValue(row.article_updated_at ?? row.articleUpdatedAt),
    articleId: row.article_external_id ?? row.articleExternalId ?? null,
    arxivId: row.arxiv_id ?? row.arxivId ?? null,
    biorxivId: row.biorxiv_id ?? row.biorxivId ?? null,
    canonicalArticleId: row.canonical_article_id ?? row.canonicalArticleId ?? null,
    ...(detailReadiness ? {detailReadiness} : {}),
    doi: row.doi ?? null,
    fullTextConversionStatus: row.full_text_conversion_status ?? row.fullTextConversionStatus ?? null,
    fullTextFetchedAt: getDateValue(row.full_text_fetched_at ?? row.fullTextFetchedAt),
    fullTextPDF: row.full_text_pdf ?? row.fullTextPDF ?? null,
    journalTitle: row.journal_title ?? row.journalTitle ?? null,
    medrxivId: row.medrxiv_id ?? row.medrxivId ?? null,
    originalData: row.original_data ?? row.originalData ?? null,
    pubmedId: row.pmid ?? null,
    selectedImportRouteId: row.selected_import_route_id ?? row.selectedImportRouteId ?? null,
    sourceMetadata: getJsonValue(row.source_metadata ?? row.sourceMetadata ?? null),
    url: row.url ?? null,
  }
}

export const getHumanReviewArticlesFromServing = async (
  params: ArticlesReviewsParams,
  dependencies?: ReviewServingRouteDependencies,
): Promise<HumanReviewArticlesResponse> => {
  const database = getRouteDatabase(dependencies)
  const routeDependencies = {...dependencies, database}
  const effectiveParams = await getParamsWithEffectiveDateFilters(params, database)
  const manifest = await getManifest(params.projectId, routeDependencies)
  const page = getResponsePage(effectiveParams)
  const limit = getLimit(effectiveParams.limit)

  if (!manifest) {
    throw new Error(reviewServingSnapshotUnavailableError)
  }

  const enabledPromptCountPromise = getEnabledPromptCount(params.projectId, routeDependencies)
  const pageResult = await readRowsPage<ReviewServingArticleRow>({
    dependencies: routeDependencies,
    label: 'human review rows',
    limit,
    request: {
      ...getBaseReaderRequest(effectiveParams, manifest, limit + 1, 'human'),
      contractKey: 'review.human.rows',
      cursor: effectiveParams.cursor ?? null,
    },
  })
  const pageRows = pageResult.rows

  const enabledPromptCount = await enabledPromptCountPromise
  const detailReadiness = pageResult.detailReadiness
  const [humanRows, totalCount] = await Promise.all([
    detailReadiness === 'ready'
      ? readJudgments(effectiveParams, manifest, 'human', pageRows, 'human', enabledPromptCount, routeDependencies)
      : Promise.resolve([]),
    getCountValue(effectiveParams, manifest, 'human', routeDependencies),
  ])
  const judgmentsByArticleId = getHumanJudgmentsByArticleId(humanRows)
  const data = pageRows.map((row) => {
    const judgments = judgmentsByArticleId.get(getArticleId(row)) ?? []
    const summaryJudgment = judgments.find((judgment) => {
      return judgment.promptId === 'summary'
    })

    return {
      ...getArticleResponseBase(row, detailReadiness),
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
    detailReadiness,
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
  const database = getRouteDatabase(dependencies)
  const routeDependencies = {...dependencies, database}
  const effectiveParams = await getParamsWithEffectiveDateFilters(params, database)
  const manifest = await getManifest(params.projectId, routeDependencies)
  const page = getResponsePage(effectiveParams)
  const limit = getLimit(effectiveParams.limit)

  if (!manifest) {
    throw new Error(reviewServingSnapshotUnavailableError)
  }

  const enabledPromptCountPromise = getEnabledPromptCount(params.projectId, routeDependencies)
  const pageResult = await readRowsPage<ReviewServingArticleRow>({
    dependencies: routeDependencies,
    label: 'both review rows',
    limit,
    request: {
      ...getBaseReaderRequest(effectiveParams, manifest, limit + 1, 'both'),
      contractKey: 'review.both.rows',
      cursor: effectiveParams.cursor ?? null,
    },
  })
  const pageRows = pageResult.rows

  const enabledPromptCount = await enabledPromptCountPromise
  const detailReadiness = pageResult.detailReadiness
  const [llmRows, humanRows, totalCount] = await Promise.all([
    detailReadiness === 'ready'
      ? readJudgments(effectiveParams, manifest, 'both', pageRows, 'llm', enabledPromptCount, routeDependencies)
      : Promise.resolve([]),
    detailReadiness === 'ready'
      ? readJudgments(effectiveParams, manifest, 'both', pageRows, 'human', enabledPromptCount, routeDependencies)
      : Promise.resolve([]),
    getCountValue(effectiveParams, manifest, 'both', routeDependencies),
  ])
  const llmJudgmentsByArticleId = getLlmJudgmentsByArticleId(llmRows)
  const humanJudgmentsByArticleId = getHumanJudgmentsByArticleId(humanRows)
  const data = pageRows.map((row) => {
    const articleId = getArticleId(row)
    const humanJudgments = humanJudgmentsByArticleId.get(articleId) ?? []
    const summaryJudgment = humanJudgments.find((judgment) => {
      return judgment.promptId === 'summary'
    })
    const judgments = llmJudgmentsByArticleId.get(articleId) ?? []

    return {
      ...getArticleResponseBase(row, detailReadiness),
      judgments: withoutInternalLlmJudgmentFields(judgments),
      humanJudgmentMode: summaryJudgment ? ('summary' as const) : ('prompt' as const),
      humanSummaryAnswer: getSummaryAnswer(summaryJudgment?.answer),
      llmSummaryAnswer: getLlmSummaryAnswer(judgments),
      ...(summaryJudgment ? {} : {humanAnswersByPrompt: getHumanAnswersByPrompt(humanJudgments)}),
    }
  })

  return {
    data,
    detailReadiness,
    totalCount,
    page,
    limit,
    totalPages: Math.ceil(totalCount / limit),
    nextCursor: pageResult.nextCursor,
  }
}

export const getUnassessedReviewArticlesFromServing = async (
  params: ArticlesReviewsParams,
  dependencies?: ReviewServingRouteDependencies,
): Promise<UnassessedReviewArticlesResponse> => {
  const database = getRouteDatabase(dependencies)
  const routeDependencies = {...dependencies, database}
  const effectiveParams = await getParamsWithEffectiveDateFilters(params, database)
  const manifest = await getManifest(params.projectId, routeDependencies)
  const page = getResponsePage(effectiveParams)
  const limit = getLimit(effectiveParams.limit)

  if (!manifest) {
    throw new Error(reviewServingSnapshotUnavailableError)
  }

  const pageResult = await readRowsPage<ReviewServingArticleRow>({
    dependencies: routeDependencies,
    label: 'unassessed article rows',
    limit,
    request: {
      ...getBaseReaderRequest(effectiveParams, manifest, limit + 1, 'unassessed'),
      contractKey: 'review.unassessed.rows',
      cursor: effectiveParams.cursor ?? null,
    },
  })
  const pageRows = pageResult.rows
  const totalCount = await getCountValue(effectiveParams, manifest, 'unassessed', routeDependencies)
  const data = pageRows.map((row) => {
    return {...getArticleResponseBase(row), judgments: [], judgedPromptIds: [], isFullyJudged: false}
  })

  return {data, totalCount, page, limit, totalPages: Math.ceil(totalCount / limit), nextCursor: pageResult.nextCursor}
}
