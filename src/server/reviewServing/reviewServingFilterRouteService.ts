import {getAppDatabaseService} from '../services/appDatabaseService.ts'
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

type PromptRow = {id: string; originalText?: string | null; promptHeading?: string | null}
type ReviewServingFilterMode = 'human' | 'review'
type ReviewServingFilterRouteParams = {
  covidenceConflicts?: string
  covidenceDuplicates?: string
  from?: string
  projectId: string
  search?: string
  to?: string
}
type ReviewServingFilterRouteDependencies = {
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
type PromptFilterResponse = {answeredOriginalValues: string[]; filterType: 'enum'; promptId: string; promptName: string}
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

const getManifest = async (projectId: string, dependencies?: ReviewServingFilterRouteDependencies) => {
  const manifestDatabase =
    dependencies?.manifestDatabase ?? (getAppDatabaseService() as ReviewServingManifestRepositoryDatabase)
  const active = await getActiveReviewServingSnapshotManifest({projectId, reviewConfigHash: null}, manifestDatabase)

  return active ?? getLastKnownGoodReviewServingSnapshotManifest({projectId, reviewConfigHash: null}, manifestDatabase)
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

  return state?.projectionIdentity ?? '$missingIdentity'
}

const getRouteFilters = (params: ReviewServingFilterRouteParams): ReviewServingReaderFilterInput => {
  const searchTokenPrefix = typeof params.search === 'string' && params.search.trim() ? params.search.trim() : undefined

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
  const searchTokenPrefix = typeof params.search === 'string' && params.search.trim() ? params.search.trim() : null

  return {
    allowStale: true,
    filters: getRouteFilters(params),
    limit,
    projectId: params.projectId,
    reviewConfigHash: manifest.reviewConfigHash,
    searchMode: searchTokenPrefix ? 'tokenPrefix' : 'none',
    searchState: searchTokenPrefix ? {availability: 'ready', snapshotId: manifest.snapshotId} : null,
    searchTokenPrefix,
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

const getPromptFilters = (
  promptRows: readonly PromptRow[],
  optionRows: readonly (ReviewServingFilterOptionRow & {optionPayload: Record<string, unknown>})[],
  mode: ReviewServingFilterMode,
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
  const promptFilters = promptRows.map((prompt) => {
    return {
      answeredOriginalValues: [...new Set(valuesByPrompt[prompt.id] ?? [])],
      filterType: 'enum' as const,
      promptId: prompt.id,
      promptName: getPromptName(prompt),
    }
  })
  const summaryFilter =
    mode === 'human' && valuesByPrompt.summary
      ? [
          {
            answeredOriginalValues: [...new Set(valuesByPrompt.summary)],
            filterType: 'enum' as const,
            promptId: 'summary',
            promptName: 'Overall human screening decision',
          },
        ]
      : []

  return mode === 'human' && valuesByPrompt.summary ? summaryFilter : promptFilters
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
  const filterOptionIdentity = getReviewServingFilterOptionIdentity({
    filterKeys: Object.keys(getRouteFilters(params)),
    listModeKeys: [mode === 'human' ? 'human' : 'llm'],
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
    filters: getPromptFilters(input.promptRows, optionResult.filterOptions, input.mode),
    searchScope: {
      availability: 'ready',
      mode: searchText ? 'tokenPrefix' : 'none',
      searchIdentity: optionResult.searchIdentity,
      text: searchText,
    },
  }
}
