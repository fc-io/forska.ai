import type {
  ArticlesReviewsBothParams,
  ArticlesReviewsBothResponse,
  ArticlesReviewsParams,
} from '../../services/olap/olapTypes.ts'
import {getAppDatabaseService} from '../services/appDatabaseService.ts'
import {getCurrentReviewConfigHash} from '../services/reviewServingProjectConfigIdentity.ts'
import {normalizeSummaryAnswerValue} from '../utils/judgmentAnswers.ts'
import type {NamedReviewFastCountKey} from './reviewServingContracts.ts'
import {
  getActiveReviewServingSnapshotManifest,
  getLastKnownGoodReviewServingSnapshotManifest,
  type ReviewServingManifestRepositoryDatabase,
  type ReviewServingSnapshotManifest,
} from './reviewServingManifestRepository.ts'
import {
  readReviewServingRows,
  type ReviewServingReaderDatabase,
  type ReviewServingReaderRequest,
} from './reviewServingReader.ts'

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
  page: number
  totalCount: number
  totalPages: number
}
type UnassessedReviewArticlesResponse = {
  data: unknown[]
  limit: number
  page: number
  totalCount: number
  totalPages: number
}
type ReviewServingRowsPageInput = {
  currentPage?: number
  dependencies?: ReviewServingRouteDependencies
  label: string
  limit: number
  page: number
  request: Omit<ReviewServingReaderRequest, 'contractKey'> & {contractKey: string}
}

const maxReviewPageSize = 100
const defaultReviewLimit = 100
const dynamicFilterKey = 'filter:dynamic'
const listAllFilterKey = 'list:all'
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

const getSearchTokenPrefix = (search: string | null | undefined) => {
  const [firstToken] =
    search
      ?.trim()
      .toLowerCase()
      .split(/\s+/u)
      .filter((token) => {
        return token.length > 0
      }) ?? []

  return firstToken ?? null
}

const getRouteFilters = (params: ArticlesReviewsBothParams | ArticlesReviewsParams, mode: ReviewServingReviewMode) => {
  const promptAnswer = getPromptAnswerFilters(params.prompts)
  const searchTokenPrefix = getSearchTokenPrefix(params.search)

  return {
    ...(params.from ? {articleCreatedAtFrom: params.from} : {}),
    ...(params.to ? {articleCreatedAtTo: params.to} : {}),
    ...(params.hasDuplicateStudyRecords ? {duplicateFlag: 'true'} : {}),
    ...(params.hasStudyDecisionConflict ? {conflictFlag: 'true'} : {}),
    ...(mode === 'unassessed' ? {queueKind: 'unassessed'} : {}),
    ...(promptAnswer.length > 0 ? {promptAnswer} : {}),
    ...(searchTokenPrefix ? {searchTokenPrefix} : {}),
  }
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
    snapshotId: manifest.snapshotId,
  }
}

const getCountState = (
  params: ArticlesReviewsBothParams | ArticlesReviewsParams,
  manifest: ReviewServingSnapshotManifest,
  mode: ReviewServingReviewMode,
) => {
  const filterKey =
    mode === 'unassessed' ? queueReadyFilterKey : hasDynamicFilters(params, mode) ? dynamicFilterKey : listAllFilterKey
  const key: NamedReviewFastCountKey =
    mode === 'unassessed'
      ? 'review.queue.unassessedReady'
      : hasDynamicFilters(params, mode)
        ? 'review.list.filteredTotal'
        : 'review.list.total'

  return {availability: 'ready' as const, filterKey, key, snapshotId: manifest.snapshotId, value: 0}
}

const getCountValue = async (
  params: ArticlesReviewsBothParams | ArticlesReviewsParams,
  manifest: ReviewServingSnapshotManifest,
  mode: ReviewServingReviewMode,
  dependencies?: ReviewServingRouteDependencies,
) => {
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

const getArticleId = (row: ReviewServingArticleRow) => {
  return row.article_id ?? row.articleId ?? ''
}

const getJudgmentPayload = (row: ReviewServingJudgmentRow) => {
  return getJsonValue(row.judgment_payload_json ?? null) as Record<string, unknown> | null
}

const getLlmJudgmentsByArticleId = (rows: readonly ReviewServingJudgmentRow[]) => {
  return rows.reduce((acc, row) => {
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
    : readReviewServingRows<ReviewServingJudgmentRow>(
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

const readRowsPage = async <T>(input: ReviewServingRowsPageInput): Promise<T[]> => {
  const currentPage = input.currentPage ?? 1
  const rowsResult = await readReviewServingRows<T>(input.request, getReaderDependencies(input.dependencies))

  if (rowsResult.status === 'rejected') {
    throw new Error(`reviewServingReader rejected ${input.label}: ${rowsResult.reason}`)
  }

  const pageRows = rowsResult.rows.slice(0, input.limit)
  const lastRow = pageRows[pageRows.length - 1]

  return currentPage >= input.page || !lastRow || pageRows.length < input.limit
    ? pageRows
    : readRowsPage({
        ...input,
        currentPage: currentPage + 1,
        request: {...input.request, cursor: rowsResult.getCursorForRow(lastRow as Record<string, unknown>)},
      })
}

const getArticleResponseBase = (row: ReviewServingArticleRow) => {
  return {
    id: getArticleId(row),
    articleTitle: row.article_title ?? row.articleTitle ?? null,
    articleCreatedAt: getDateValue(row.sort_key),
    articleUpdatedAt: getDateValue(row.activity_sort_at),
    articleId: row.article_external_id ?? row.articleExternalId ?? null,
    journalTitle: row.journal_title ?? row.journalTitle ?? null,
    selectedImportRouteId: row.selected_import_route_id ?? row.selectedImportRouteId ?? null,
    url: row.url ?? null,
  }
}

export const getHumanReviewArticlesFromServing = async (
  params: ArticlesReviewsParams,
  dependencies?: ReviewServingRouteDependencies,
): Promise<HumanReviewArticlesResponse> => {
  const manifest = await getManifest(params.projectId, dependencies)
  const page = getPage(params.page)
  const limit = getLimit(params.limit)

  if (!manifest) {
    throw new Error('Review serving snapshot is unavailable')
  }

  const pageRows = await readRowsPage<ReviewServingArticleRow>({
    dependencies,
    label: 'human review rows',
    limit,
    page,
    request: {
      ...getBaseReaderRequest(params, manifest, limit, 'human'),
      contractKey: 'review.human.rows',
      cursor: params.cursor ?? null,
    },
  })

  const articleIds = pageRows.map(getArticleId)
  const humanRows = await readJudgments(params, manifest, 'human', articleIds, 'human', dependencies)
  const judgmentsByArticleId = getHumanJudgmentsByArticleId(humanRows)
  const totalCount = await getCountValue(params, manifest, 'human', dependencies)
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
  }
}

export const getBothReviewArticlesFromServing = async (
  params: ArticlesReviewsBothParams,
  dependencies?: ReviewServingRouteDependencies,
): Promise<ArticlesReviewsBothResponse> => {
  const manifest = await getManifest(params.projectId, dependencies)
  const page = getPage(params.page)
  const limit = getLimit(params.limit)

  if (!manifest) {
    throw new Error('Review serving snapshot is unavailable')
  }

  const pageRows = await readRowsPage<ReviewServingArticleRow>({
    dependencies,
    label: 'both review rows',
    limit,
    page,
    request: {...getBaseReaderRequest(params, manifest, limit, 'both'), contractKey: 'review.both.rows'},
  })

  const articleIds = pageRows.map(getArticleId)
  const [llmRows, humanRows] = await Promise.all([
    readJudgments(params, manifest, 'both', articleIds, 'llm', dependencies),
    readJudgments(params, manifest, 'both', articleIds, 'human', dependencies),
  ])
  const llmJudgmentsByArticleId = getLlmJudgmentsByArticleId(llmRows)
  const humanJudgmentsByArticleId = getHumanJudgmentsByArticleId(humanRows)
  const totalCount = await getCountValue(params, manifest, 'both', dependencies)
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

  return {data, totalCount, page, limit, totalPages: Math.ceil(totalCount / limit)}
}

export const getUnassessedReviewArticlesFromServing = async (
  params: ArticlesReviewsParams,
  dependencies?: ReviewServingRouteDependencies,
): Promise<UnassessedReviewArticlesResponse> => {
  const manifest = await getManifest(params.projectId, dependencies)
  const page = getPage(params.page)
  const limit = getLimit(params.limit)

  if (!manifest) {
    throw new Error('Review serving snapshot is unavailable')
  }

  const pageRows = await readRowsPage<ReviewServingArticleRow>({
    dependencies,
    label: 'unassessed article rows',
    limit,
    page,
    request: {
      ...getBaseReaderRequest(params, manifest, limit, 'unassessed'),
      contractKey: 'review.unassessed.rows',
      cursor: params.cursor ?? null,
    },
  })
  const totalCount = await getCountValue(params, manifest, 'unassessed', dependencies)
  const data = pageRows.map((row) => {
    return {...getArticleResponseBase(row), judgments: [], judgedPromptIds: [], isFullyJudged: false}
  })

  return {data, totalCount, page, limit, totalPages: Math.ceil(totalCount / limit)}
}
