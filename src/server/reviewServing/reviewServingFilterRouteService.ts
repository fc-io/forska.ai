import {buildNumericFilterResultFromValues} from '../routes/projectsRoutes/articlesReviewsFiltersNumeric.ts'
import {analyzePromptTypes, extractSpecialValues} from '../routes/projectsRoutes/articlesReviewsFiltersUtils.ts'
import {getAppDatabaseService} from '../services/appDatabaseService.ts'
import {getCurrentReviewConfigHash} from '../services/reviewServingProjectConfigIdentity.ts'
import {getReviewServingFilterOptionIdentity} from './reviewServingFilterOptionProjector.ts'
import {
  getActiveReviewServingSnapshotManifest,
  getLastKnownGoodReviewServingSnapshotManifest,
  type ReviewServingManifestRepositoryDatabase,
  type ReviewServingSnapshotManifest,
} from './reviewServingManifestRepository.ts'
import {
  readReviewServingRows,
  type ReviewServingReaderDatabase,
  type ReviewServingReaderDiagnostics,
  type ReviewServingReaderFilterInput,
  type ReviewServingReaderRequest,
} from './reviewServingReader.ts'
import {getReviewServingTitleSearchTokens} from './reviewServingTitleSearchProjector.ts'

type PromptRow = {id: string; originalText: string; promptHeading: string | null; type: string | null}
type ReviewServingFilterMode = 'human' | 'review'
type HumanJudgmentMode = 'prompt' | 'summary'
type ReviewServingFilterRouteParams = {
  covidenceConflicts?: string
  covidenceDuplicates?: string
  from?: string
  projectId: string
  search?: string
  to?: string
}
type ReviewServingFilterRouteDependencies = {
  currentReviewConfigHash?: string | null
  database?: ReviewServingReaderDatabase
  manifestDatabase?: ReviewServingManifestRepositoryDatabase
}
type ReviewServingFacetRow = {
  answer_id?: number | null
  answer_value?: string | null
  availability?: string | null
  count_value?: number | null
  facet_key?: string | null
  facet_kind?: string | null
  facet_value?: string | null
  prompt_id?: string | null
  stale_reason?: string | null
  summary_definition_version?: string | null
  summary_identity?: string | null
}
type ReviewServingFilterOptionRow = {
  answer_id?: number | null
  count_value?: number | null
  facet_key?: string | null
  facet_value?: string | null
  filter_kind?: string | null
  numeric_max?: number | null
  numeric_min?: number | null
  option_payload_json?: Record<string, unknown> | string | null
  option_value_key?: string | null
  prompt_id?: string | null
}
type PromptFilterResponse =
  | {answeredOriginalValues: string[]; filterType: 'enum'; promptId: string; promptName: string}
  | {
      bins: Array<{label: string; min: number; max: number}>
      filterType: 'numeric'
      promptId: string
      promptName: string
      specialValues: string[]
    }
type ReviewFilterRouteResponse = {
  diagnostics: ReviewServingReaderDiagnostics[]
  facets: ReviewServingFacetRow[]
  filterOptions: Array<ReviewServingFilterOptionRow & {optionPayload: Record<string, unknown>; optionValueKey: string}>
  filters: PromptFilterResponse[]
  searchScope: {
    availability: 'ready' | 'unavailable'
    mode: 'none' | 'tokenPrefix'
    searchIdentity: string
    text: string | null
  }
}

const reviewFacetSummaryIdentities = [
  'review.filter.duplicateFlag',
  'review.filter.importRoute',
  'review.filter.promptAnswer',
  'review.filter.publicationYear',
] as const
const humanFacetSummaryIdentities = ['review.human.filter.promptAnswer', 'review.human.filter.summaryAnswer'] as const
const filterOptionRouteLimit = 512
const filterFacetRouteLimit = 128
const defaultReviewFilterOptionKeys = [
  'conflictFlag',
  'duplicateFlag',
  'humanStatus',
  'importRoute',
  'llmStatus',
  'promptAnswer',
  'publicationYear',
  'searchTokenPrefix',
] as const
const defaultHumanFilterOptionKeys = [
  'conflictFlag',
  'duplicateFlag',
  'humanStatus',
  'importRoute',
  'promptAnswer',
  'publicationYear',
  'searchTokenPrefix',
] as const
const defaultHumanListModeKeys = ['human', 'both'] as const
const defaultReviewListModeKeys = ['llm', 'human', 'both', 'unassessed'] as const

const getSearchTokenPrefixes = (search: string | null | undefined) => {
  return getReviewServingTitleSearchTokens(search ?? null)
}

const getSearchTokenPrefix = (search: string | null | undefined) => {
  const [firstToken] = getSearchTokenPrefixes(search)

  return firstToken ?? null
}

const getManifest = async (projectId: string, dependencies?: ReviewServingFilterRouteDependencies) => {
  const manifestDatabase =
    dependencies?.manifestDatabase ?? (getAppDatabaseService() as ReviewServingManifestRepositoryDatabase)
  const reviewConfigHash = dependencies?.currentReviewConfigHash ?? (await getCurrentReviewConfigHash(projectId))
  const active = await getActiveReviewServingSnapshotManifest({projectId, reviewConfigHash}, manifestDatabase)

  return active ?? getLastKnownGoodReviewServingSnapshotManifest({projectId, reviewConfigHash}, manifestDatabase)
}

const getReaderDependencies = (dependencies?: ReviewServingFilterRouteDependencies) => {
  return {
    ...(dependencies?.database ? {database: dependencies.database} : {}),
    ...(dependencies?.manifestDatabase
      ? {diagnosticsDatabase: dependencies.manifestDatabase, manifestDatabase: dependencies.manifestDatabase}
      : {}),
  }
}

const getComponentIdentity = (manifest: ReviewServingSnapshotManifest, component: string) => {
  const state = [...manifest.componentState.required, ...manifest.componentState.optional].find((entry) => {
    return entry.component === component
  })

  return state?.projectionIdentity ?? ''
}

const getRouteFilters = (params: ReviewServingFilterRouteParams): ReviewServingReaderFilterInput => {
  const searchTokenPrefix = getSearchTokenPrefix(params.search)

  return {
    ...(params.from ? {articleCreatedAtFrom: params.from} : {}),
    ...(params.to ? {articleCreatedAtTo: params.to} : {}),
    ...(params.covidenceDuplicates === '1' ? {duplicateFlag: 'true'} : {}),
    ...(params.covidenceConflicts === '1' ? {conflictFlag: 'true'} : {}),
    ...(searchTokenPrefix ? {searchTokenPrefix} : {}),
  }
}

const getBaseReaderRequest = (
  params: ReviewServingFilterRouteParams,
  manifest: ReviewServingSnapshotManifest,
  limit: number,
): Omit<ReviewServingReaderRequest, 'contractKey'> => {
  const searchTokenPrefix = getSearchTokenPrefix(params.search)

  return {
    allowStale: true,
    filters: getRouteFilters(params),
    limit,
    projectId: params.projectId,
    reviewConfigHash: manifest.reviewConfigHash,
    searchMode: searchTokenPrefix ? 'tokenPrefix' : 'none',
    searchState: searchTokenPrefix ? {availability: 'ready', snapshotId: manifest.snapshotId} : null,
    searchTokenPrefix,
    searchTokenPrefixes: getSearchTokenPrefixes(params.search),
    snapshotId: manifest.snapshotId,
  }
}

const getOptionPayload = (row: ReviewServingFilterOptionRow) => {
  if (typeof row.option_payload_json === 'string') {
    return JSON.parse(row.option_payload_json) as Record<string, unknown>
  }

  return row.option_payload_json ?? {}
}

const getFacetSummaryIdentities = (mode: ReviewServingFilterMode) => {
  return mode === 'human' ? humanFacetSummaryIdentities : reviewFacetSummaryIdentities
}

const getPromptName = (prompt: PromptRow) => {
  return prompt.promptHeading || prompt.originalText || prompt.id
}

const getNumericValuesByPrompt = (
  optionRows: readonly (ReviewServingFilterOptionRow & {optionPayload: Record<string, unknown>})[],
  mode: ReviewServingFilterMode,
) => {
  return optionRows.reduce<Record<string, number[]>>((acc, row) => {
    const promptId = typeof row.optionPayload.promptId === 'string' ? row.optionPayload.promptId : row.prompt_id
    const value =
      typeof row.optionPayload.value === 'string' ? Number(row.optionPayload.value) : Number(row.facet_value)
    const isPromptAnswer = row.facet_key === 'promptAnswer'
    const isModeMatch = mode === 'human' ? row.filter_kind === 'human' : row.filter_kind === 'review'

    return isPromptAnswer && isModeMatch && promptId && Number.isFinite(value)
      ? {...acc, [promptId]: [...(acc[promptId] ?? []), value]}
      : acc
  }, {})
}

const getPromptFilters = (
  promptRows: readonly PromptRow[],
  optionRows: readonly (ReviewServingFilterOptionRow & {optionPayload: Record<string, unknown>})[],
  mode: ReviewServingFilterMode,
  humanJudgmentMode: HumanJudgmentMode = 'summary',
) => {
  const valuesByPrompt = optionRows.reduce<Record<string, string[]>>((acc, row) => {
    const promptId = typeof row.optionPayload.promptId === 'string' ? row.optionPayload.promptId : row.prompt_id
    const value = typeof row.optionPayload.value === 'string' ? row.optionPayload.value : row.facet_value
    const isPromptAnswer = row.facet_key === 'promptAnswer'
    const isModeMatch = mode === 'human' ? row.filter_kind === 'human' : row.filter_kind === 'review'

    return isPromptAnswer && isModeMatch && promptId && value
      ? {...acc, [promptId]: [...(acc[promptId] ?? []), value]}
      : acc
  }, {})
  const numericValuesByPrompt = getNumericValuesByPrompt(optionRows, mode)
  const promptStrategies = analyzePromptTypes([...promptRows])
  const promptFilters = promptRows.map((prompt) => {
    const promptStrategy = promptStrategies.find((strategy) => {
      return strategy.promptId === prompt.id
    })

    if (promptStrategy?.strategy === 'numeric') {
      return buildNumericFilterResultFromValues(
        prompt.id,
        getPromptName(prompt),
        numericValuesByPrompt[prompt.id] ?? [],
        prompt.type ? extractSpecialValues(prompt.type) : [],
      )
    }

    return {
      answeredOriginalValues: [...new Set(valuesByPrompt[prompt.id] ?? [])],
      filterType: 'enum' as const,
      promptId: prompt.id,
      promptName: getPromptName(prompt),
    }
  })
  const summaryFilter = [
    {
      answeredOriginalValues: [...new Set(valuesByPrompt.summary ?? [])],
      filterType: 'enum' as const,
      promptId: 'summary',
      promptName: 'Overall human screening decision',
    },
  ]

  return mode === 'human' && humanJudgmentMode === 'summary' ? summaryFilter : promptFilters
}

const readFacetRows = async (
  params: ReviewServingFilterRouteParams,
  manifest: ReviewServingSnapshotManifest,
  mode: ReviewServingFilterMode,
  dependencies?: ReviewServingFilterRouteDependencies,
) => {
  const baseRequest = getBaseReaderRequest(params, manifest, filterFacetRouteLimit)
  const results = await Promise.all(
    getFacetSummaryIdentities(mode).map((summaryIdentity) => {
      return readReviewServingRows<ReviewServingFacetRow>(
        {
          ...baseRequest,
          contractKey: mode === 'human' ? 'review.human.filters.facets' : 'review.filters.facets',
          countFilterKey: summaryIdentity,
        },
        getReaderDependencies(dependencies),
      )
    }),
  )
  const diagnostics = results.map((result) => {
    return result.diagnostics
  })
  const facets = results.flatMap((result) => {
    return result.status === 'accepted' ? result.rows : []
  })

  return {diagnostics, facets}
}

const readOptionRows = async (
  params: ReviewServingFilterRouteParams,
  manifest: ReviewServingSnapshotManifest,
  mode: ReviewServingFilterMode,
  dependencies?: ReviewServingFilterRouteDependencies,
) => {
  const searchIdentity = getComponentIdentity(manifest, 'search')
  const activeFilters = getRouteFilters(params)
  const filterOptionIdentity = getReviewServingFilterOptionIdentity({
    activeFilters,
    filterKeys: mode === 'human' ? defaultHumanFilterOptionKeys : defaultReviewFilterOptionKeys,
    listModeKeys: mode === 'human' ? defaultHumanListModeKeys : defaultReviewListModeKeys,
    optionMode: mode,
    searchIdentity,
  })
  const result = await readReviewServingRows<ReviewServingFilterOptionRow>(
    {
      ...getBaseReaderRequest(params, manifest, filterOptionRouteLimit),
      contractKey: mode === 'human' ? 'review.human.filters.options' : 'review.filters.options',
      filterOptionIdentity,
      searchIdentity,
    },
    getReaderDependencies(dependencies),
  )
  const filterOptions =
    result.status === 'accepted'
      ? result.rows.map((row) => {
          return {...row, optionPayload: getOptionPayload(row), optionValueKey: row.option_value_key ?? ''}
        })
      : []

  return {diagnostics: [result.diagnostics], filterOptions, searchIdentity}
}

export const getReviewFiltersFromServing = async (input: {
  dependencies?: ReviewServingFilterRouteDependencies
  humanJudgmentMode?: HumanJudgmentMode
  mode: ReviewServingFilterMode
  params: ReviewServingFilterRouteParams
  promptRows: readonly PromptRow[]
}): Promise<ReviewFilterRouteResponse> => {
  const manifest = await getManifest(input.params.projectId, input.dependencies)

  if (!manifest) {
    return {
      diagnostics: [],
      facets: [],
      filterOptions: [],
      filters: [],
      searchScope: {availability: 'unavailable', mode: 'none', searchIdentity: '$missingIdentity', text: null},
    }
  }

  const [{diagnostics: facetDiagnostics, facets}, optionResult] = await Promise.all([
    readFacetRows(input.params, manifest, input.mode, input.dependencies),
    readOptionRows(input.params, manifest, input.mode, input.dependencies),
  ])
  const searchText =
    typeof input.params.search === 'string' && input.params.search.trim() ? input.params.search.trim() : null

  return {
    diagnostics: [...facetDiagnostics, ...optionResult.diagnostics],
    facets,
    filterOptions: optionResult.filterOptions,
    filters: getPromptFilters(input.promptRows, optionResult.filterOptions, input.mode, input.humanJudgmentMode),
    searchScope: {
      availability: 'ready',
      mode: searchText ? 'tokenPrefix' : 'none',
      searchIdentity: optionResult.searchIdentity,
      text: searchText,
    },
  }
}
