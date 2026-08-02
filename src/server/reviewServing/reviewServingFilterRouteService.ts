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
type ReviewServingFilterMode = 'both' | 'human' | 'review'
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
  facetKey?: string | null
  facetKind?: string | null
  facet_key?: string | null
  facet_kind?: string | null
  facet_value?: string | null
  promptId?: string | null
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
type PromptFilterDefinition = {
  articleReadinessState: 'fast' | 'slow'
  debugDisplayState: 'mart/fast' | 'mart/slow' | 'project/fast' | 'project/slow'
  kind: 'numeric' | 'openString' | 'schemaEnum'
  label: string
  optionSourceState: 'fast' | 'schema' | 'slow' | 'unavailable'
  options: Array<{label: string; value: string}>
  promptId: string
  selectedValues: string[]
  source: 'mart' | 'project'
  surface: 'both' | 'human' | 'llm' | 'summary'
}
type ReviewFilterRouteResponse = {
  diagnostics: ReviewServingReaderDiagnostics[]
  facets: ReviewServingFacetRow[]
  filterOptions: Array<ReviewServingFilterOptionRow & {optionPayload: Record<string, unknown>; optionValueKey: string}>
  filters: PromptFilterResponse[]
  promptFilterDefinitions: PromptFilterDefinition[]
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
const humanSummaryAnswerOptions = ['yes', 'no', 'maybe'] as const
const bothHumanSummaryPromptId = 'human:promptAnswer:summary'
const bothLlmSummaryPromptId = 'review:promptAnswer:summary'
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

const getOptionPayload = (row: ReviewServingFilterOptionRow): Record<string, unknown> => {
  const value = row.facet_value ?? ''
  const isPromptAnswer = row.facet_key === 'promptAnswer'
  const isHumanSummaryAnswer = row.filter_kind === 'human' && row.prompt_id === 'summary'

  return isPromptAnswer
    ? {filterType: 'enum', promptId: row.prompt_id ?? '', ...(isHumanSummaryAnswer ? {summaryMode: true} : {}), value}
    : {facetKey: row.facet_key ?? '', filterType: 'enum', value}
}

const getFacetSummaryIdentities = (mode: ReviewServingFilterMode) => {
  return mode === 'human' ? humanFacetSummaryIdentities : reviewFacetSummaryIdentities
}

const getServingFilterReadMode = (mode: ReviewServingFilterMode): 'human' | 'review' => {
  return mode === 'human' ? 'human' : 'review'
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

const getPromptAnswerAvailabilityByPrompt = (
  facetRows: readonly ReviewServingFacetRow[],
  mode: ReviewServingFilterMode,
) => {
  return facetRows.reduce<Record<string, string>>((acc, row) => {
    const facetKey = row.facet_key ?? row.facetKey
    const facetKind = row.facet_kind ?? row.facetKind
    const isPromptAnswer = facetKey === 'promptAnswer'
    const isModeMatch = mode === 'human' ? facetKind === 'human' : facetKind === 'review'
    const promptId = row.prompt_id ?? row.promptId ?? null

    if (!isPromptAnswer || !isModeMatch || !promptId) {
      return acc
    }

    const availability = row.availability ?? 'unavailable'
    const existingAvailability = acc[promptId]
    const nextAvailability =
      existingAvailability && existingAvailability !== 'ready'
        ? existingAvailability
        : availability === 'ready' && existingAvailability !== undefined
          ? existingAvailability
          : availability

    return {...acc, [promptId]: nextAvailability}
  }, {})
}

const getArticleReadinessState = (availability: string | undefined): 'fast' | 'slow' => {
  return availability === 'ready' ? 'fast' : 'slow'
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

    if (promptStrategy?.strategy === 'enum' && promptStrategy.enumOptions) {
      return {
        answeredOriginalValues: promptStrategy.enumOptions,
        filterType: 'enum' as const,
        promptId: prompt.id,
        promptName: getPromptName(prompt),
      }
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
      answeredOriginalValues: [...humanSummaryAnswerOptions],
      filterType: 'enum' as const,
      promptId: 'summary',
      promptName: 'Overall human screening decision',
    },
  ]
  const bothSummaryFilters = [
    {
      answeredOriginalValues: [...humanSummaryAnswerOptions],
      filterType: 'enum' as const,
      promptId: bothHumanSummaryPromptId,
      promptName: 'Overall human screening decision',
    },
    {
      answeredOriginalValues: [...humanSummaryAnswerOptions],
      filterType: 'enum' as const,
      promptId: bothLlmSummaryPromptId,
      promptName: 'LLM screening decision',
    },
  ]

  return mode === 'human' && humanJudgmentMode === 'summary'
    ? summaryFilter
    : mode === 'both' && humanJudgmentMode === 'summary'
      ? bothSummaryFilters
      : promptFilters
}

const getSelectedValuesByPrompt = (params: ReviewServingFilterRouteParams) => {
  const promptParams = params as ReviewServingFilterRouteParams & {prompts?: unknown}

  if (!promptParams.prompts || typeof promptParams.prompts !== 'object') {
    return {}
  }

  return Object.entries(promptParams.prompts as Record<string, unknown>).reduce<Record<string, string[]>>(
    (acc, [key, value]) => {
      if (Array.isArray(value)) {
        return {
          ...acc,
          [key]: value.filter((entry): entry is string => {
            return typeof entry === 'string'
          }),
        }
      }

      return typeof value === 'string' ? {...acc, [key]: [value]} : acc
    },
    {},
  )
}

const getPromptFilterDefinitions = (input: {
  facetRows: readonly ReviewServingFacetRow[]
  humanJudgmentMode: HumanJudgmentMode
  mode: ReviewServingFilterMode
  optionRows: readonly (ReviewServingFilterOptionRow & {optionPayload: Record<string, unknown>})[]
  params: ReviewServingFilterRouteParams
  promptRows: readonly PromptRow[]
}): PromptFilterDefinition[] => {
  const selectedValuesByPrompt = getSelectedValuesByPrompt(input.params)
  const valuesByPrompt = input.optionRows.reduce<Record<string, string[]>>((acc, row) => {
    const promptId = typeof row.optionPayload.promptId === 'string' ? row.optionPayload.promptId : row.prompt_id
    const value = typeof row.optionPayload.value === 'string' ? row.optionPayload.value : row.facet_value
    const isPromptAnswer = row.facet_key === 'promptAnswer'
    const isModeMatch = input.mode === 'human' ? row.filter_kind === 'human' : row.filter_kind === 'review'

    return isPromptAnswer && isModeMatch && promptId && value
      ? {...acc, [promptId]: [...(acc[promptId] ?? []), value]}
      : acc
  }, {})
  const promptAnswerAvailabilityByPrompt = getPromptAnswerAvailabilityByPrompt(input.facetRows, input.mode)

  if (input.mode === 'human' && input.humanJudgmentMode === 'summary') {
    const articleReadinessState = getArticleReadinessState(promptAnswerAvailabilityByPrompt.summary)
    const options = humanSummaryAnswerOptions.map((value) => {
      return {label: value, value}
    })

    return [
      {
        articleReadinessState,
        debugDisplayState: `project/${articleReadinessState}`,
        kind: 'schemaEnum',
        label: 'Overall human screening decision',
        optionSourceState: 'schema',
        options,
        promptId: 'summary',
        selectedValues: selectedValuesByPrompt.summary ?? [],
        source: 'project',
        surface: 'summary',
      },
    ]
  }

  if (input.mode === 'both' && input.humanJudgmentMode === 'summary') {
    const humanAvailabilityByPrompt = getPromptAnswerAvailabilityByPrompt(input.facetRows, 'human')
    const humanArticleReadinessState = getArticleReadinessState(humanAvailabilityByPrompt.summary)
    const hasReadyLlmPromptPostings =
      input.promptRows.length > 0
      && input.promptRows.every((prompt) => {
        return promptAnswerAvailabilityByPrompt[prompt.id] === 'ready'
      })
    const llmArticleReadinessState = hasReadyLlmPromptPostings ? 'fast' : 'slow'
    const options = humanSummaryAnswerOptions.map((value) => {
      return {label: value, value}
    })

    return [
      {
        articleReadinessState: humanArticleReadinessState,
        debugDisplayState: `project/${humanArticleReadinessState}`,
        kind: 'schemaEnum',
        label: 'Overall human screening decision',
        optionSourceState: 'schema',
        options,
        promptId: bothHumanSummaryPromptId,
        selectedValues: selectedValuesByPrompt[bothHumanSummaryPromptId] ?? [],
        source: 'project',
        surface: 'summary',
      },
      {
        articleReadinessState: llmArticleReadinessState,
        debugDisplayState: `project/${llmArticleReadinessState}`,
        kind: 'schemaEnum',
        label: 'LLM screening decision',
        optionSourceState: 'schema',
        options,
        promptId: bothLlmSummaryPromptId,
        selectedValues: selectedValuesByPrompt[bothLlmSummaryPromptId] ?? [],
        source: 'project',
        surface: 'llm',
      },
    ]
  }

  const promptStrategies = analyzePromptTypes([...input.promptRows])

  return input.promptRows.map((prompt) => {
    const strategy = promptStrategies.find((candidate) => {
      return candidate.promptId === prompt.id
    })
    const label = getPromptName(prompt)
    const kind =
      strategy?.strategy === 'enum' ? 'schemaEnum' : strategy?.strategy === 'numeric' ? 'numeric' : 'openString'
    const source = kind === 'schemaEnum' ? 'project' : 'mart'
    const articleReadinessState = getArticleReadinessState(promptAnswerAvailabilityByPrompt[prompt.id])
    const schemaOptions = strategy?.strategy === 'enum' ? (strategy.enumOptions ?? []) : []
    const martOptions = [...new Set(valuesByPrompt[prompt.id] ?? [])]
    const optionValues = schemaOptions.length > 0 ? schemaOptions : martOptions
    const optionSourceState = source === 'project' ? 'schema' : martOptions.length > 0 ? 'fast' : 'unavailable'

    return {
      articleReadinessState,
      debugDisplayState: `${source}/${articleReadinessState}`,
      kind,
      label,
      optionSourceState,
      options: optionValues.map((value) => {
        return {label: value, value}
      }),
      promptId: prompt.id,
      selectedValues: selectedValuesByPrompt[prompt.id] ?? [],
      source,
      surface: input.mode === 'human' ? 'human' : 'llm',
    }
  })
}

const readFacetRows = async (
  params: ReviewServingFilterRouteParams,
  manifest: ReviewServingSnapshotManifest,
  mode: ReviewServingFilterMode,
  dependencies?: ReviewServingFilterRouteDependencies,
) => {
  const readMode = getServingFilterReadMode(mode)
  const summaryIdentities = getFacetSummaryIdentities(readMode)
  const result = await readReviewServingRows<ReviewServingFacetRow>(
    {
      ...getBaseReaderRequest(params, manifest, filterFacetRouteLimit),
      contractKey: readMode === 'human' ? 'review.human.filters.facets' : 'review.filters.facets',
      countFilterKey: summaryIdentities[0] ?? null,
      countFilterKeys: summaryIdentities,
    },
    getReaderDependencies(dependencies),
  )
  const facets = result.status === 'accepted' ? result.rows : []

  return {diagnostics: [result.diagnostics], facets}
}

const readOptionRows = async (
  params: ReviewServingFilterRouteParams,
  manifest: ReviewServingSnapshotManifest,
  mode: ReviewServingFilterMode,
  dependencies?: ReviewServingFilterRouteDependencies,
) => {
  const readMode = getServingFilterReadMode(mode)
  const searchIdentity = getComponentIdentity(manifest, 'search')
  const filterOptionIdentity = getReviewServingFilterOptionIdentity({
    filterKeys: readMode === 'human' ? defaultHumanFilterOptionKeys : defaultReviewFilterOptionKeys,
    listModeKeys: readMode === 'human' ? defaultHumanListModeKeys : defaultReviewListModeKeys,
    optionMode: readMode,
    searchIdentity,
  })
  const result = await readReviewServingRows<ReviewServingFilterOptionRow>(
    {
      ...getBaseReaderRequest(params, manifest, filterOptionRouteLimit),
      contractKey: readMode === 'human' ? 'review.human.filters.options' : 'review.filters.options',
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
      promptFilterDefinitions: [],
      searchScope: {availability: 'unavailable', mode: 'none', searchIdentity: '$missingIdentity', text: null},
    }
  }

  const shouldReadBothSummarySources = input.mode === 'both' && input.humanJudgmentMode === 'summary'
  const [{diagnostics: facetDiagnostics, facets}, optionResult] = shouldReadBothSummarySources
    ? await Promise.all([
        Promise.all([
          readFacetRows(input.params, manifest, 'review', input.dependencies),
          readFacetRows(input.params, manifest, 'human', input.dependencies),
        ]).then(([reviewResult, humanResult]) => {
          return {
            diagnostics: [...reviewResult.diagnostics, ...humanResult.diagnostics],
            facets: [...reviewResult.facets, ...humanResult.facets],
          }
        }),
        Promise.all([
          readOptionRows(input.params, manifest, 'review', input.dependencies),
          readOptionRows(input.params, manifest, 'human', input.dependencies),
        ]).then(([reviewResult, humanResult]) => {
          return {
            diagnostics: [...reviewResult.diagnostics, ...humanResult.diagnostics],
            filterOptions: [...reviewResult.filterOptions, ...humanResult.filterOptions],
            searchIdentity: reviewResult.searchIdentity || humanResult.searchIdentity,
          }
        }),
      ])
    : await Promise.all([
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
    promptFilterDefinitions: getPromptFilterDefinitions({
      facetRows: facets,
      humanJudgmentMode: input.humanJudgmentMode ?? 'summary',
      mode: input.mode,
      optionRows: optionResult.filterOptions,
      params: input.params,
      promptRows: input.promptRows,
    }),
    searchScope: {
      availability: 'ready',
      mode: searchText ? 'tokenPrefix' : 'none',
      searchIdentity: optionResult.searchIdentity,
      text: searchText,
    },
  }
}
