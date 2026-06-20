import {getAppDatabaseService} from '../services/appDatabaseService.ts'
import {getApiReadOnlyAppDatabaseService} from '../services/appReadOnlyDatabaseService.ts'
import type {DuckdbWorkloadContext} from '../utils/duckdbService.ts'
import {admitReviewServingDuckdbWorkload, type ReviewServingAdmissionDiagnostics} from './reviewServingAdmission.ts'
import {
  type NamedReviewFastCountKey,
  type ReviewServingBulkState,
  type ReviewServingCountState,
  type ReviewServingFilterKey,
  reviewServingFilterKeys,
  type ReviewServingFreshnessState,
  type ReviewServingListMode,
  type ReviewServingProjectionComponent,
  type ReviewServingReadContract,
  type ReviewServingSearchMode,
  type ReviewServingSearchState,
  type ReviewServingSnapshotStatus,
} from './reviewServingContracts.ts'
import {
  decodeAndValidateReviewServingCursor,
  encodeReviewServingCursor,
  getReviewServingCursorSortKey,
  getReviewServingFilterSignature,
  type ReviewServingCursorComponentState,
  type ReviewServingCursorFailureReason,
  type ReviewServingFilterSignatureValue,
} from './reviewServingCursor.ts'
import {getReviewServingDiagnostics, type ReviewServingDiagnostics} from './reviewServingDiagnosticsRepository.ts'
import {
  getActiveReviewServingSnapshotManifest,
  getLastKnownGoodReviewServingSnapshotManifest,
  getReviewServingSnapshotManifest,
  type ReviewServingManifestRepositoryDatabase,
  type ReviewServingSnapshotManifest,
} from './reviewServingManifestRepository.ts'
import {getReviewServingReadContract} from './reviewServingReadContracts.ts'
import {assertReviewServingSqlShape, buildReviewServingRowsSql} from './reviewServingSql.ts'

export type ReviewServingReaderDatabase = {
  queryJson: <T>(statement: string, workloadContext?: DuckdbWorkloadContext) => Promise<T[]>
}

export type ReviewServingReaderFilterInput = Partial<Record<string, ReviewServingFilterSignatureValue>>

export type ReviewServingReaderRequest = {
  allowStale?: boolean
  articleId?: string | null
  articleIds?: readonly string[] | null
  contractKey: string
  countFilterKey?: string | null
  countState?: ReviewServingCountState | null
  cursor?: string | null
  estimatedHydratedPayloadBytes?: number
  estimatedResultBytes?: number
  estimatedResultRows?: number
  filterKind?: string | null
  filterOptionIdentity?: string | null
  filters?: ReviewServingReaderFilterInput
  filterValue?: string | null
  jobFilterSignature?: string | null
  jobState?: ReviewServingBulkState | null
  limit: number
  listMode?: ReviewServingListMode | null
  namedCountKey?: NamedReviewFastCountKey | null
  projectId?: string | null
  queueKind?: string | null
  requiresTempSpill?: boolean
  reviewConfigHash?: string | null
  searchIdentity?: string | null
  searchMode?: ReviewServingSearchMode | 'substringSync'
  searchState?: ReviewServingSearchState | null
  searchText?: string | null
  searchTokenPrefix?: string | null
  searchTokenPrefixes?: readonly string[] | null
  snapshotId?: string | null
}

export type ReviewServingReaderRejectionReason =
  | 'admissionRejected'
  | 'articleSetBoundsRejected'
  | 'cursorInvalid'
  | 'filterSignatureMismatch'
  | 'manifestStatusRejected'
  | 'missingRequiredComponentState'
  | 'servingIdentityMissing'
  | 'sqlBuildFailed'
  | 'sqlShapeRejected'
  | 'unsupportedContractKey'
  | 'unsupportedFilterKey'

export type ReviewServingReaderDiagnostics = {
  admission: ReviewServingAdmissionDiagnostics | null
  contractKey: string
  cursor: {reason: ReviewServingCursorFailureReason | null; valid: boolean}
  diagnostics: ReviewServingDiagnostics | null
  filterSignature: string | null
  manifest: {
    freshness: ReviewServingFreshnessState
    lastError: string | null
    projectId: string | null
    snapshotId: string | null
    status: ReviewServingSnapshotStatus | 'missing'
  }
  missingRequiredComponents: readonly ReviewServingProjectionComponent[]
  rejectionReason: ReviewServingReaderRejectionReason | null
  sqlShapeViolations: readonly {label: string; pattern: string}[]
}

export type ReviewServingReaderResult<T> =
  | {
      contract: ReviewServingReadContract
      diagnostics: ReviewServingReaderDiagnostics
      getCursorForRow: (row: Record<string, unknown>) => string
      rows: T[]
      sql: string
      status: 'accepted'
    }
  | {
      contract: ReviewServingReadContract | null
      diagnostics: ReviewServingReaderDiagnostics
      reason: ReviewServingReaderRejectionReason
      sql: string | null
      status: 'rejected'
    }

const snapshotScopedTables = new Set(['app.review_serving_snapshot_manifest'])
const maxArticleSetHydrationArticleIds = 100
const maxArticleSetHydrationPayloadBytes = 2_000_000
const reviewServingArticleTable = 'mart.review_article_serving_v4'

const getReaderDatabase = () => {
  return getApiReadOnlyAppDatabaseService()
}

const hasText = (value: string | null | undefined) => {
  return typeof value === 'string' && value.trim().length > 0
}

const isReviewServingFilterKey = (value: string): value is ReviewServingFilterKey => {
  return (reviewServingFilterKeys as readonly string[]).includes(value)
}

const getManifestFreshness = (manifest: ReviewServingSnapshotManifest | null): ReviewServingFreshnessState => {
  if (!manifest) {
    return 'unavailable'
  }

  if (manifest.status === 'active') {
    return 'ready'
  }

  if (manifest.status === 'retired') {
    return 'stale'
  }

  return manifest.status === 'candidate' ? 'indexing' : 'unavailable'
}

const getManifestDiagnostics = (manifest: ReviewServingSnapshotManifest | null) => {
  const status: ReviewServingSnapshotStatus | 'missing' = manifest?.status ?? 'missing'

  return {
    freshness: getManifestFreshness(manifest),
    lastError: manifest?.lastError ?? null,
    projectId: manifest?.projectId ?? null,
    snapshotId: manifest?.snapshotId ?? null,
    status,
  }
}

const getComponentCursorStates = (manifest: ReviewServingSnapshotManifest | null) => {
  const entries = [...(manifest?.componentState.required ?? []), ...(manifest?.componentState.optional ?? [])]

  return entries.reduce<Partial<Record<ReviewServingProjectionComponent, ReviewServingCursorComponentState>>>(
    (states, state) => {
      return {
        ...states,
        [state.component]: {
          baseGeneration: state.baseGeneration,
          patchWatermark: state.patchWatermark,
          projectionIdentity: state.projectionIdentity,
        },
      }
    },
    {},
  )
}

const getComponentIdentity = (
  manifest: ReviewServingSnapshotManifest | null,
  component: ReviewServingProjectionComponent,
) => {
  return getComponentCursorStates(manifest)[component]?.projectionIdentity ?? '$missingIdentity'
}

const getMissingRequiredComponents = (
  contract: ReviewServingReadContract,
  manifest: ReviewServingSnapshotManifest | null,
) => {
  const componentStates = getComponentCursorStates(manifest)

  return contract.requiredComponents.filter((component) => {
    return componentStates[component] === undefined
  })
}

const getMissingRuntimeComponents = (
  contract: ReviewServingReadContract,
  manifest: ReviewServingSnapshotManifest | null,
  request: ReviewServingReaderRequest,
) => {
  const componentStates = getComponentCursorStates(manifest)
  const searchComponents = request.searchMode === 'tokenPrefix' && !componentStates.search ? ['search' as const] : []

  return [...getMissingRequiredComponents(contract, manifest), ...searchComponents]
}

const getUnsupportedFilterKeys = (contract: ReviewServingReadContract, filters: ReviewServingReaderFilterInput) => {
  const allowedFilters = new Set(contract.allowedFilters)

  return Object.keys(filters).filter((filterKey) => {
    return !isReviewServingFilterKey(filterKey) || !allowedFilters.has(filterKey)
  })
}

const hasValidArticleSetBounds = (contract: ReviewServingReadContract, request: ReviewServingReaderRequest) => {
  if (contract.physicalAccessStrategy !== 'articleSetLookup') {
    return true
  }

  const articleIdCount = request.articleIds?.length ?? 0
  const hydratedPayloadBytes = request.estimatedHydratedPayloadBytes ?? 0

  return (
    articleIdCount > 0
    && articleIdCount <= maxArticleSetHydrationArticleIds
    && Number.isFinite(hydratedPayloadBytes)
    && hydratedPayloadBytes >= 0
    && hydratedPayloadBytes <= maxArticleSetHydrationPayloadBytes
  )
}

const getCursorFieldName = (field: string) => {
  return field.replace(/\s+(?:asc|desc)\b[\s\S]*$/iu, '').trim()
}

const getCursorPredicateFieldName = (contract: ReviewServingReadContract, field: string) => {
  const fieldName = getCursorFieldName(field)

  return contract.servingTable === reviewServingArticleTable && /^[a-z_][a-z0-9_]*$/iu.test(fieldName)
    ? `${reviewServingArticleTable}.${fieldName}`
    : fieldName
}

const getCursorRowFieldName = (field: string) => {
  const fieldName = getCursorFieldName(field)

  return fieldName.startsWith('CASE list_mode_key ') ? 'list_mode_priority' : fieldName
}

const getCursorFieldDirection = (field: string, contract: ReviewServingReadContract) => {
  const direction = field.match(/\s+(asc|desc)\b/iu)?.[1]?.toLowerCase()

  return direction === 'asc' || direction === 'desc' ? direction : contract.sort.direction
}

const getCursorPredicatePart = (input: {
  contract: ReviewServingReadContract
  cursorValues: readonly (null | number | string)[]
  index: number
}) => {
  const equalPredicates = input.contract.cursorFields.slice(0, input.index).map((field, fieldIndex) => {
    return `${getCursorPredicateFieldName(input.contract, field)} IS NOT DISTINCT FROM $cursor${fieldIndex}`
  })
  const field = input.contract.cursorFields[input.index] ?? ''
  const fieldName = getCursorPredicateFieldName(input.contract, field)
  const direction = getCursorFieldDirection(field, input.contract)
  const operator = direction === 'asc' ? '>' : '<'
  const comparison = `${fieldName} ${operator} $cursor${input.index}`

  return [...equalPredicates, comparison].join(' AND ')
}

const getCursorPredicate = (contract: ReviewServingReadContract, cursorValues: readonly (null | number | string)[]) => {
  if (cursorValues.length === 0 || contract.cursorFields.length === 0) {
    return undefined
  }

  return cursorValues
    .map((_value, index) => {
      return `(${getCursorPredicatePart({contract, cursorValues, index})})`
    })
    .join(' OR ')
}

const getCursorSqlParameters = (cursorValues: readonly (null | number | string)[] | null) => {
  return (cursorValues ?? []).reduce<Record<string, null | number | string>>((acc, value, index) => {
    return {...acc, [`cursor${index}`]: value}
  }, {})
}

const getCursorSortValue = (value: unknown): null | number | string => {
  if (value instanceof Date) {
    return value.toISOString()
  }

  return value === null || typeof value === 'number' || typeof value === 'string' ? value : null
}

const createCursorForRow = (input: {
  contract: ReviewServingReadContract
  filterSignature: string
  manifest: ReviewServingSnapshotManifest
  row: Record<string, unknown>
}) => {
  const sortValues = input.contract.cursorFields.map((field) => {
    return getCursorSortValue(input.row[getCursorRowFieldName(field)])
  })
  const articleIdValue = input.row.article_id ?? input.row.articleId
  const articleId = typeof articleIdValue === 'string' ? articleIdValue : ''

  return encodeReviewServingCursor({
    articleId,
    componentStates: getComponentCursorStates(input.manifest),
    contractKey: input.contract.key,
    filterSignature: input.filterSignature,
    reviewConfigHash: input.manifest.reviewConfigHash,
    snapshotId: input.manifest.snapshotId,
    sortDirection: input.contract.sort.direction,
    sortKey: getReviewServingCursorSortKey(input.contract.cursorFields),
    sortValues,
    version: 1,
  })
}

const getPostingFilterPrefix = (listMode: ReviewServingListMode | null | undefined) => {
  return listMode === 'human' ? 'human:promptAnswer:' : 'review:promptAnswer:'
}

const getFilterValues = (value: ReviewServingFilterSignatureValue | undefined) => {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => {
        return typeof entry === 'string' && entry.length > 0
      })
    : typeof value === 'string' && value.length > 0
      ? [value]
      : []
}

const getFilterString = (value: ReviewServingFilterSignatureValue | undefined) => {
  return typeof value === 'string' && value.length > 0 ? value : null
}

const getPromptAnswerValueGroups = (request: ReviewServingReaderRequest) => {
  const prefix = getPostingFilterPrefix(request.listMode)

  return getFilterValues(request.filters?.promptAnswer).reduce<string[][]>((groups, value) => {
    const [promptId] = value.split(':')
    const currentGroup = groups.find((group) => {
      return group.some((entry) => {
        return entry.startsWith(`${prefix}${promptId}:`)
      })
    })

    return currentGroup
      ? groups.map((group) => {
          return group === currentGroup ? [...group, `${prefix}${value}`] : group
        })
      : [...groups, [`${prefix}${value}`]]
  }, [])
}

const getExclusiveDateToFilter = (value: string | null) => {
  if (!value || !isDateOnlyFilter(value)) {
    return value
  }

  const date = new Date(`${value}T00:00:00.000Z`)
  date.setUTCDate(date.getUTCDate() + 1)

  return date.toISOString().slice(0, 10)
}

const isDateOnlyFilter = (value: string) => {
  return /^\d{4}-\d{2}-\d{2}$/.test(value)
}

const getColumnFilterPredicates = (request: ReviewServingReaderRequest) => {
  const filters = request.filters ?? {}
  const llmStatus =
    filters.llmStatus === 'complete' ? 'answered' : filters.llmStatus === 'partial' ? 'unanswered' : null
  const articleCreatedAtFrom = getFilterString(filters.articleCreatedAtFrom)
  const articleCreatedAtTo = getFilterString(filters.articleCreatedAtTo)

  return [
    articleCreatedAtFrom ? 'article_created_at >= TIMESTAMPTZ $articleCreatedAtFrom' : '',
    articleCreatedAtTo
      ? isDateOnlyFilter(articleCreatedAtTo)
        ? 'article_created_at < TIMESTAMPTZ $articleCreatedAtTo'
        : 'article_created_at <= TIMESTAMPTZ $articleCreatedAtTo'
      : '',
    filters.duplicateFlag ? `duplicate_flag = TRUE` : '',
    filters.conflictFlag ? `conflict_flag = TRUE` : '',
    filters.llmHasJudgment ? 'llm_judged_prompt_count > 0' : '',
    llmStatus ? 'llm_status_key = $llmStatusFilter' : '',
    typeof filters.humanStatus === 'string' ? 'human_status_key = $humanStatusFilter' : '',
  ].filter((predicate) => {
    return predicate.length > 0
  })
}

const getPostingFilterPredicate = (input: {
  contract: ReviewServingReadContract
  filterKind: string
  filterValues: readonly string[]
  index: number
  request: ReviewServingReaderRequest
}) => {
  return input.filterValues.length === 0
    ? ''
    : [
        `EXISTS (SELECT 1 FROM mart.review_article_filter_posting_serving_v4 filter_${input.index}`,
        ` WHERE filter_${input.index}.project_id = $projectId`,
        ` AND filter_${input.index}.snapshot_id = $snapshotId`,
        ` AND filter_${input.index}.review_config_hash = $reviewConfigHash`,
        ` AND filter_${input.index}.list_mode_key = ${getSqlLiteral(input.request.listMode ?? input.contract.listMode)}`,
        ` AND filter_${input.index}.article_id = ${input.contract.servingTable}.article_id`,
        ` AND filter_${input.index}.filter_kind = $promptAnswerFilterKind`,
        ` AND filter_${input.index}.filter_value IN (SELECT unnest(${getSqlLiteral(input.filterValues)})))`,
      ].join('')
}

const getPostingFilterPredicates = (input: {
  contract: ReviewServingReadContract
  request: ReviewServingReaderRequest
}) => {
  return getPromptAnswerValueGroups(input.request)
    .map((filterValues, index) => {
      return getPostingFilterPredicate({
        contract: input.contract,
        filterKind: 'promptAnswer',
        filterValues,
        index,
        request: input.request,
      })
    })
    .filter((predicate) => {
      return predicate.length > 0
    })
}

const getSearchFilterPredicate = (input: {
  contract: ReviewServingReadContract
  manifest: ReviewServingSnapshotManifest
  request: ReviewServingReaderRequest
}) => {
  const componentStates = getComponentCursorStates(input.manifest)
  const searchTokenPrefixes =
    input.request.searchTokenPrefixes ?? (input.request.searchTokenPrefix ? [input.request.searchTokenPrefix] : [])

  return searchTokenPrefixes.length > 0 && componentStates.search?.projectionIdentity
    ? [
        'NOT EXISTS (SELECT 1 FROM (SELECT unnest($searchTokenPrefixes) AS token_prefix) search_prefix',
        ' WHERE NOT EXISTS (SELECT 1 FROM mart.review_title_search_serving_v4 search',
        ' WHERE search.project_id = $projectId',
        ' AND search.search_identity = $searchIdentity',
        ' AND search.project_scope_identity = $projectScopeIdentity',
        ' AND search.snapshot_id = $snapshotId',
        ` AND search.article_id = ${input.contract.servingTable}.article_id`,
        ' AND starts_with(search.token, search_prefix.token_prefix)))',
      ].join('')
    : ''
}

const getLlmStatusFilterValue = (request: ReviewServingReaderRequest) => {
  return request.filters?.llmStatus === 'complete'
    ? 'answered'
    : request.filters?.llmStatus === 'partial'
      ? 'unanswered'
      : null
}

const getOrderedPrefixFilterPredicatesSql = (input: {
  contract: ReviewServingReadContract
  manifest: ReviewServingSnapshotManifest
  request: ReviewServingReaderRequest
}) => {
  if (input.contract.physicalAccessStrategy !== 'orderedPrefix') {
    return null
  }

  const predicates = [
    ...getColumnFilterPredicates(input.request),
    ...getPostingFilterPredicates({contract: input.contract, request: input.request}),
    getSearchFilterPredicate(input),
  ].filter((predicate) => {
    return predicate.length > 0
  })

  return predicates.length > 0 ? ` AND ${predicates.join(' AND ')}` : null
}

const getQueueOrderingFilterPredicatesSql = (input: {
  contract: ReviewServingReadContract
  request: ReviewServingReaderRequest
}) => {
  if (input.contract.physicalAccessStrategy !== 'queueOrdering') {
    return null
  }

  const filters = input.request.filters ?? {}
  const articleCreatedAtFrom = getFilterString(filters.articleCreatedAtFrom)
  const articleCreatedAtTo = getFilterString(filters.articleCreatedAtTo)
  const predicates = [
    articleCreatedAtFrom ? 'article_created_at >= TIMESTAMPTZ $articleCreatedAtFrom' : '',
    articleCreatedAtTo
      ? isDateOnlyFilter(articleCreatedAtTo)
        ? 'article_created_at < TIMESTAMPTZ $articleCreatedAtTo'
        : 'article_created_at <= TIMESTAMPTZ $articleCreatedAtTo'
      : '',
  ].filter((predicate) => {
    return predicate.length > 0
  })

  return predicates.length > 0 ? ` AND ${predicates.join(' AND ')}` : null
}

const getFilterPredicatesSql = (input: {
  contract: ReviewServingReadContract
  manifest: ReviewServingSnapshotManifest
  request: ReviewServingReaderRequest
}) => {
  return getOrderedPrefixFilterPredicatesSql(input) ?? getQueueOrderingFilterPredicatesSql(input)
}

const getFilterSignatureInput = (request: ReviewServingReaderRequest) => {
  return {
    articleId: request.articleId ?? undefined,
    articleIds: request.articleIds ?? undefined,
    filterKind: request.filterKind ?? undefined,
    filters: request.filters ?? {},
    filterValue: request.filterValue ?? undefined,
    jobFilterSignature: request.jobFilterSignature ?? undefined,
    listMode: request.listMode ?? undefined,
    queueKind: request.queueKind ?? undefined,
    searchText: request.searchText ?? undefined,
    searchTokenPrefix: request.searchTokenPrefix ?? undefined,
    searchTokenPrefixes: request.searchTokenPrefixes ?? undefined,
  }
}

const getReaderDiagnostics = (input: {
  admission: ReviewServingAdmissionDiagnostics | null
  contractKey: string
  cursorReason?: ReviewServingCursorFailureReason | null
  cursorValid?: boolean
  diagnostics: ReviewServingDiagnostics | null
  filterSignature: string | null
  manifest: ReviewServingSnapshotManifest | null
  missingRequiredComponents?: readonly ReviewServingProjectionComponent[]
  rejectionReason: ReviewServingReaderRejectionReason | null
  sqlShapeViolations?: readonly {label: string; pattern: string}[]
}): ReviewServingReaderDiagnostics => {
  return {
    admission: input.admission,
    contractKey: input.contractKey,
    cursor: {reason: input.cursorReason ?? null, valid: input.cursorValid ?? true},
    diagnostics: input.diagnostics,
    filterSignature: input.filterSignature,
    manifest: getManifestDiagnostics(input.manifest),
    missingRequiredComponents: input.missingRequiredComponents ?? [],
    rejectionReason: input.rejectionReason,
    sqlShapeViolations: input.sqlShapeViolations ?? [],
  }
}

const rejectReaderRequest = <T>(input: {
  admission: ReviewServingAdmissionDiagnostics | null
  contract: ReviewServingReadContract | null
  contractKey?: string
  cursorReason?: ReviewServingCursorFailureReason | null
  cursorValid?: boolean
  diagnostics: ReviewServingDiagnostics | null
  filterSignature: string | null
  manifest: ReviewServingSnapshotManifest | null
  missingRequiredComponents?: readonly ReviewServingProjectionComponent[]
  reason: ReviewServingReaderRejectionReason
  sql?: string | null
  sqlShapeViolations?: readonly {label: string; pattern: string}[]
}): ReviewServingReaderResult<T> => {
  return {
    contract: input.contract,
    diagnostics: getReaderDiagnostics({
      admission: input.admission,
      contractKey: input.contract?.key ?? input.contractKey ?? 'unsupported',
      cursorReason: input.cursorReason,
      cursorValid: input.cursorValid,
      diagnostics: input.diagnostics,
      filterSignature: input.filterSignature,
      manifest: input.manifest,
      missingRequiredComponents: input.missingRequiredComponents,
      rejectionReason: input.reason,
      sqlShapeViolations: input.sqlShapeViolations,
    }),
    reason: input.reason,
    sql: input.sql ?? null,
    status: 'rejected',
  }
}

const getSnapshotManifest = async (
  request: ReviewServingReaderRequest,
  manifestDatabase: ReviewServingManifestRepositoryDatabase,
) => {
  if (!hasText(request.projectId)) {
    return null
  }

  if (hasText(request.snapshotId)) {
    return getReviewServingSnapshotManifest(
      {projectId: request.projectId as string, snapshotId: request.snapshotId as string},
      manifestDatabase,
    )
  }

  const active = await getActiveReviewServingSnapshotManifest(
    {projectId: request.projectId as string, reviewConfigHash: request.reviewConfigHash},
    manifestDatabase,
  )

  return (
    active
    ?? getLastKnownGoodReviewServingSnapshotManifest(
      {projectId: request.projectId as string, reviewConfigHash: request.reviewConfigHash},
      manifestDatabase,
    )
  )
}

const getRequiredIdentityParameter = (
  manifest: ReviewServingSnapshotManifest | null,
  component: ReviewServingProjectionComponent,
) => {
  return hasText(getComponentIdentity(manifest, component)) ? `$${component}Identity` : '$missingIdentity'
}

const getSql = (input: {
  contract: ReviewServingReadContract
  cursorPredicate?: string
  request: ReviewServingReaderRequest
  manifest: ReviewServingSnapshotManifest
}) => {
  return buildReviewServingRowsSql({
    articleIdParameter: input.request.articleId ? '$articleId' : null,
    articleIdsParameter: input.request.articleIds ? '$articleIds' : null,
    contract: input.contract,
    countFilterKeyParameter: input.request.countFilterKey ? '$countFilterKey' : null,
    cursorPredicate: input.cursorPredicate,
    displayIdentityParameter: getRequiredIdentityParameter(input.manifest, 'display'),
    filterKindParameter: input.request.filterKind ? '$filterKind' : null,
    filterOptionIdentityParameter: input.request.filterOptionIdentity ? '$filterOptionIdentity' : null,
    filterValueParameter: input.request.filterValue ? '$filterValue' : null,
    filterPredicatesSql: getFilterPredicatesSql(input),
    jobFilterSignatureParameter: input.request.jobFilterSignature ? '$jobFilterSignature' : null,
    limitParameter: '$limit',
    listModeParameter: '$listMode',
    namedCountKey: input.request.namedCountKey,
    payloadIdentityParameter: getRequiredIdentityParameter(input.manifest, 'payload'),
    projectIdParameter: '$projectId',
    projectScopeIdentityParameter: getRequiredIdentityParameter(input.manifest, 'projectScope'),
    queueKindParameter: input.request.queueKind ? '$queueKind' : null,
    reviewConfigHashParameter: '$reviewConfigHash',
    searchIdentityParameter: input.request.searchIdentity
      ? '$searchIdentity'
      : getRequiredIdentityParameter(input.manifest, 'search'),
    searchTextParameter: input.request.searchText ? '$searchText' : null,
    searchTokenPrefixParameter: input.request.searchTokenPrefix ? '$searchTokenPrefix' : null,
    searchTokenPrefixesParameter: input.request.searchTokenPrefix ? '$searchTokenPrefixes' : null,
    snapshotIdParameter: '$snapshotId',
  })
}

const getSqlLiteral = (value: null | number | readonly string[] | string | undefined) => {
  if (value === null || value === undefined) {
    return 'NULL'
  }

  if (typeof value === 'number') {
    return Number.isFinite(value) ? String(value) : 'NULL'
  }

  if (typeof value !== 'string') {
    const values = value.map((entry) => {
      return `'${entry.replaceAll("'", "''")}'`
    })

    return `[${values.join(', ')}]::VARCHAR[]`
  }

  return `'${value.replaceAll("'", "''")}'`
}

const escapeRegExp = (value: string) => {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

const bindReviewServingRowsSql = (
  sql: string,
  request: ReviewServingReaderRequest,
  manifest: ReviewServingSnapshotManifest,
  cursorValues: readonly (null | number | string)[] | null,
) => {
  const componentStates = getComponentCursorStates(manifest)
  const parameters: Record<string, null | number | readonly string[] | string | undefined> = {
    articleId: request.articleId ?? null,
    articleIds: request.articleIds ?? null,
    articleCreatedAtFrom: getFilterString(request.filters?.articleCreatedAtFrom),
    articleCreatedAtTo: getExclusiveDateToFilter(getFilterString(request.filters?.articleCreatedAtTo)),
    countFilterKey: request.countFilterKey ?? null,
    displayIdentity: componentStates.display?.projectionIdentity,
    filterKind: request.filterKind ?? null,
    filterOptionIdentity: request.filterOptionIdentity ?? null,
    filterValue: request.filterValue ?? null,
    jobFilterSignature: request.jobFilterSignature ?? null,
    limit: request.limit,
    listMode: request.listMode ?? null,
    llmStatusFilter: getLlmStatusFilterValue(request),
    humanStatusFilter: getFilterString(request.filters?.humanStatus),
    payloadIdentity: componentStates.payload?.projectionIdentity,
    projectId: request.projectId ?? null,
    projectScopeIdentity: componentStates.projectScope?.projectionIdentity,
    promptAnswerFilterKind: 'promptAnswer',
    promptAnswerFilterValues: [],
    queueKind: request.queueKind ?? null,
    reviewConfigHash: manifest.reviewConfigHash,
    searchIdentity: request.searchIdentity ?? componentStates.search?.projectionIdentity,
    searchText: request.searchText ?? null,
    searchTokenPrefix: request.searchTokenPrefix ?? null,
    searchTokenPrefixes: request.searchTokenPrefixes ?? (request.searchTokenPrefix ? [request.searchTokenPrefix] : []),
    snapshotId: manifest.snapshotId,
  }

  const cursorParameters = getCursorSqlParameters(cursorValues)

  const parameterEntries = Object.entries({...parameters, ...cursorParameters}).sort(([left], [right]) => {
    return right.length - left.length
  })
  const parameterValues = new Map(parameterEntries)
  const parameterPattern = new RegExp(
    `\\$(${parameterEntries
      .map(([key]) => {
        return escapeRegExp(key)
      })
      .join('|')})(?![A-Za-z0-9_])`,
    'gu',
  )

  return sql.replace(parameterPattern, (_match, key: string) => {
    return getSqlLiteral(parameterValues.get(key))
  })
}

export const readReviewServingRows = async <T>(
  request: ReviewServingReaderRequest,
  dependencies?: {
    database?: ReviewServingReaderDatabase
    diagnosticsDatabase?: ReviewServingManifestRepositoryDatabase
    manifestDatabase?: ReviewServingManifestRepositoryDatabase
  },
): Promise<ReviewServingReaderResult<T>> => {
  const contract = getReviewServingReadContract(request.contractKey)
  const manifestDatabase =
    dependencies?.manifestDatabase
    ?? dependencies?.diagnosticsDatabase
    ?? (getAppDatabaseService() as ReviewServingManifestRepositoryDatabase)
  const diagnosticsDatabase = dependencies?.diagnosticsDatabase ?? manifestDatabase
  const diagnostics = hasText(request.projectId)
    ? await getReviewServingDiagnostics(
        {projectId: request.projectId as string, reviewConfigHash: request.reviewConfigHash},
        diagnosticsDatabase,
      )
    : null
  const manifest = await getSnapshotManifest(request, manifestDatabase)
  const filterSignature = contract ? getReviewServingFilterSignature(getFilterSignatureInput(request)) : null

  if (!contract) {
    return rejectReaderRequest({
      admission: null,
      contract,
      contractKey: request.contractKey,
      diagnostics,
      filterSignature,
      manifest,
      reason: 'unsupportedContractKey',
    })
  }

  const unsupportedFilterKeys = getUnsupportedFilterKeys(contract, request.filters ?? {})

  if (unsupportedFilterKeys.length > 0) {
    return rejectReaderRequest({
      admission: null,
      contract,
      diagnostics,
      filterSignature,
      manifest,
      reason: 'unsupportedFilterKey',
    })
  }

  if (!hasText(request.projectId) || !manifest?.snapshotId) {
    return rejectReaderRequest({
      admission: null,
      contract,
      diagnostics,
      filterSignature,
      manifest,
      reason: 'servingIdentityMissing',
    })
  }

  if (!hasValidArticleSetBounds(contract, request)) {
    return rejectReaderRequest({
      admission: null,
      contract,
      diagnostics,
      filterSignature,
      manifest,
      reason: 'articleSetBoundsRejected',
    })
  }

  const missingRequiredComponents = getMissingRuntimeComponents(contract, manifest, request)

  if (missingRequiredComponents.length > 0) {
    return rejectReaderRequest({
      admission: null,
      contract,
      diagnostics,
      filterSignature,
      manifest,
      missingRequiredComponents,
      reason: 'missingRequiredComponentState',
    })
  }

  const sortKey = getReviewServingCursorSortKey(contract.cursorFields)
  const cursor = request.cursor
    ? decodeAndValidateReviewServingCursor(request.cursor, {
        componentStates: getComponentCursorStates(manifest),
        contractKey: contract.key,
        filterSignature: filterSignature as string,
        reviewConfigHash: manifest.reviewConfigHash,
        snapshotId: manifest.snapshotId,
        sortDirection: contract.sort.direction,
        sortKey,
      })
    : null

  if (cursor && !cursor.valid) {
    return rejectReaderRequest({
      admission: null,
      contract,
      cursorReason: cursor.reason,
      cursorValid: false,
      diagnostics,
      filterSignature,
      manifest,
      reason: cursor.reason === 'filterSignatureMismatch' ? 'filterSignatureMismatch' : 'cursorInvalid',
    })
  }

  const admission = admitReviewServingDuckdbWorkload({
    allowStale: request.allowStale,
    contractKey: contract.key,
    countFilterKey: request.countFilterKey ?? undefined,
    countState: request.countState,
    estimatedResultBytes: request.estimatedResultBytes,
    estimatedResultRows: request.estimatedResultRows,
    jobState: request.jobState,
    namedCountKey: request.namedCountKey ?? undefined,
    pageSize: request.limit,
    projectId: request.projectId ?? undefined,
    requiresTempSpill: request.requiresTempSpill,
    searchMode: request.searchMode,
    searchState: request.searchState,
    snapshotFreshness: getManifestFreshness(manifest),
    snapshotId: manifest.snapshotId,
    workloadClass: contract.workloadClass,
  })

  if (!admission.admitted) {
    return rejectReaderRequest({
      admission: admission.diagnostics,
      contract,
      diagnostics,
      filterSignature,
      manifest,
      reason: admission.reason === 'staleSnapshotRequired' ? 'manifestStatusRejected' : 'admissionRejected',
    })
  }

  let sql: string

  try {
    sql = getSql({
      contract,
      cursorPredicate: cursor?.valid ? getCursorPredicate(contract, cursor.payload.sortValues) : undefined,
      manifest,
      request,
    })
  } catch (_error) {
    return rejectReaderRequest({
      admission: admission.diagnostics,
      contract,
      diagnostics,
      filterSignature,
      manifest,
      reason: 'sqlBuildFailed',
    })
  }

  const shape = assertReviewServingSqlShape(sql, {
    requireSnapshotScope: !snapshotScopedTables.has(contract.servingTable),
  })

  if (!shape.ok) {
    return rejectReaderRequest({
      admission: admission.diagnostics,
      contract,
      diagnostics,
      filterSignature,
      manifest,
      reason: 'sqlShapeRejected',
      sql,
      sqlShapeViolations: shape.violations,
    })
  }

  const database = dependencies?.database ?? getReaderDatabase()
  const executableSql = bindReviewServingRowsSql(
    sql,
    request,
    manifest,
    cursor?.valid ? cursor.payload.sortValues : null,
  )
  const rows = await database.queryJson<T>(executableSql, admission.workloadContext)

  return {
    contract,
    diagnostics: getReaderDiagnostics({
      admission: admission.diagnostics,
      contractKey: contract.key,
      diagnostics,
      filterSignature,
      manifest,
      rejectionReason: null,
    }),
    getCursorForRow: (row) => {
      return createCursorForRow({contract, filterSignature: filterSignature as string, manifest, row})
    },
    rows,
    sql,
    status: 'accepted',
  }
}
