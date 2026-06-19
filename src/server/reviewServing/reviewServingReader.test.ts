import {expect, test} from 'bun:test'

import type {DuckdbWorkloadContext} from '../utils/duckdbService.ts'
import type {ReviewServingProjectionComponent, ReviewServingSnapshotStatus} from './reviewServingContracts.ts'
import {
  decodeReviewServingCursor,
  encodeReviewServingCursor,
  getReviewServingCursorSortKey,
  getReviewServingFilterSignature,
} from './reviewServingCursor.ts'
import type {ReviewServingManifestRepositoryDatabase} from './reviewServingManifestRepository.ts'
import {readReviewServingRows, type ReviewServingReaderDatabase} from './reviewServingReader.ts'

const llmRowComponents: readonly ReviewServingProjectionComponent[] = [
  'display',
  'projectScope',
  'selectedImport',
  'payload',
  'llmStatus',
  'posting',
  'summary',
]
const hydratedListComponents: readonly ReviewServingProjectionComponent[] = [
  'display',
  'projectScope',
  'selectedImport',
  'payload',
  'llmStatus',
  'humanStatus',
  'posting',
  'summary',
  'search',
]

const getComponentState = (components: readonly ReviewServingProjectionComponent[]) => {
  return {
    optional: [],
    required: components.map((component) => {
      return {
        baseGeneration: '1',
        component,
        patchWatermark: '2',
        projectionIdentity: `${component}-identity`,
        requirement: 'required' as const,
      }
    }),
  }
}

const getSnapshotRow = (input: {
  components?: readonly ReviewServingProjectionComponent[]
  lastError?: string | null
  snapshotId?: string
  status: ReviewServingSnapshotStatus
}) => {
  const components = input.components ?? llmRowComponents

  return {
    componentStateJson: getComponentState(components),
    composedIdentityJson: {snapshot: input.snapshotId ?? `${input.status}-snapshot`},
    lastError: input.lastError ?? null,
    lastKnownGoodSnapshotId: input.status === 'active' ? 'retired-snapshot' : null,
    optionalComponentsJson: [],
    projectId: 'project-1',
    requiredComponentsJson: components,
    reviewConfigHash: 'config-1',
    selectedImportSnapshotId: 'selected-import-snapshot-1',
    snapshotId: input.snapshotId ?? `${input.status}-snapshot`,
    snapshotStatus: input.status,
    sourceWatermarksJson: {},
    validationResultJson: null,
  }
}

const getDiagnosticsRows = (statement: string) => {
  if (statement.includes('GROUP BY snapshot_status')) {
    return [{snapshotCount: 1, snapshotStatus: 'active'}]
  }

  return []
}

const createManifestDatabase = (input: {active?: unknown; bySnapshot?: Record<string, unknown>; retired?: unknown}) => {
  const database: ReviewServingManifestRepositoryDatabase = {
    queryJson: async <T>(statement: string): Promise<T[]> => {
      if (!statement.includes('FROM app.review_serving_snapshot_manifest')) {
        return getDiagnosticsRows(statement) as T[]
      }

      if (statement.includes("snapshot_status = 'active'")) {
        return input.active ? ([input.active] as T[]) : []
      }

      if (statement.includes("snapshot_status = 'retired'")) {
        return input.retired ? ([input.retired] as T[]) : []
      }

      const match = statement.match(/snapshot_id = '([^']+)'/u)
      const snapshot = match ? input.bySnapshot?.[match[1] ?? ''] : null

      return snapshot ? ([snapshot] as T[]) : []
    },
    run: async () => {},
    transaction: async (operation) => {
      return operation(database)
    },
  }

  return database
}

const createReaderDatabase = (rows: readonly unknown[] = [{article_id: 'article-1'}]) => {
  const statements: string[] = []
  const workloads: unknown[] = []
  const database: ReviewServingReaderDatabase = {
    queryJson: async <T>(statement: string, workloadContext?: DuckdbWorkloadContext): Promise<T[]> => {
      statements.push(statement)
      workloads.push(workloadContext)

      return rows as T[]
    },
  }

  return {database, statements, workloads}
}

const readyRequest = {
  contractKey: 'review.llm.rows',
  limit: 25,
  projectId: 'project-1',
  reviewConfigHash: 'config-1',
  snapshotId: 'active-snapshot',
} as const

test('readReviewServingRows admits ready manifests and executes serving SQL only after shape assertion', async () => {
  const reader = createReaderDatabase()
  const manifestDatabase = createManifestDatabase({
    bySnapshot: {'active-snapshot': getSnapshotRow({snapshotId: 'active-snapshot', status: 'active'})},
  })
  const result = await readReviewServingRows<{article_id: string}>(readyRequest, {
    database: reader.database,
    diagnosticsDatabase: manifestDatabase,
    manifestDatabase,
  })

  expect(result.status).toBe('accepted')
  expect(result.status === 'accepted' ? result.rows : []).toEqual([{article_id: 'article-1'}])
  expect(reader.statements).toHaveLength(1)
  expect(reader.statements[0]).toContain('FROM mart.review_article_serving_v4')
  expect(reader.statements[0]).toContain("WHERE mart.review_article_serving_v4.project_id = 'project-1'")
  expect(reader.statements[0]).toContain("mart.review_article_serving_v4.snapshot_id = 'active-snapshot'")
  expect(reader.statements[0]).not.toContain('$projectId')
  expect(reader.statements[0]).not.toContain('selected_scoped_article_import')
  expect(reader.workloads[0]).toMatchObject({fallbackIntent: 'reject', routeOrJobKey: 'review.llm.rows'})
})

test('readReviewServingRows rejects unsupported contracts before DuckDB execution', async () => {
  const reader = createReaderDatabase()
  const manifestDatabase = createManifestDatabase({
    bySnapshot: {'active-snapshot': getSnapshotRow({snapshotId: 'active-snapshot', status: 'active'})},
  })
  const result = await readReviewServingRows(
    {...readyRequest, contractKey: 'review.rawFallback.rows'},
    {database: reader.database, diagnosticsDatabase: manifestDatabase, manifestDatabase},
  )

  expect(result).toMatchObject({reason: 'unsupportedContractKey', status: 'rejected'})
  expect(result.diagnostics.contractKey).toBe('review.rawFallback.rows')
  expect(reader.statements).toHaveLength(0)
})

test('readReviewServingRows rejects missing project and missing snapshot identity before DuckDB execution', async () => {
  const reader = createReaderDatabase()
  const emptyManifestDatabase = createManifestDatabase({})
  const missingProject = await readReviewServingRows(
    {...readyRequest, projectId: null},
    {database: reader.database, diagnosticsDatabase: emptyManifestDatabase, manifestDatabase: emptyManifestDatabase},
  )
  const missingSnapshot = await readReviewServingRows(
    {...readyRequest, snapshotId: 'missing-snapshot'},
    {database: reader.database, diagnosticsDatabase: emptyManifestDatabase, manifestDatabase: emptyManifestDatabase},
  )

  expect(missingProject).toMatchObject({reason: 'servingIdentityMissing', status: 'rejected'})
  expect(missingSnapshot).toMatchObject({reason: 'servingIdentityMissing', status: 'rejected'})
  expect(missingSnapshot.diagnostics.manifest).toMatchObject({snapshotId: null, status: 'missing'})
  expect(reader.statements).toHaveLength(0)
})

test('readReviewServingRows rejects stale snapshots unless stale reads are explicit', async () => {
  const reader = createReaderDatabase()
  const manifestDatabase = createManifestDatabase({
    bySnapshot: {'retired-snapshot': getSnapshotRow({snapshotId: 'retired-snapshot', status: 'retired'})},
  })
  const rejected = await readReviewServingRows(
    {...readyRequest, snapshotId: 'retired-snapshot'},
    {database: reader.database, diagnosticsDatabase: manifestDatabase, manifestDatabase},
  )
  const accepted = await readReviewServingRows(
    {...readyRequest, allowStale: true, snapshotId: 'retired-snapshot'},
    {database: reader.database, diagnosticsDatabase: manifestDatabase, manifestDatabase},
  )

  expect(rejected).toMatchObject({reason: 'manifestStatusRejected', status: 'rejected'})
  expect(rejected.diagnostics.manifest).toMatchObject({freshness: 'stale', status: 'retired'})
  expect(accepted.status).toBe('accepted')
})

test('readReviewServingRows reports indexing unavailable and failed manifest diagnostics without DuckDB execution', async () => {
  const reader = createReaderDatabase()
  const manifestDatabase = createManifestDatabase({
    bySnapshot: {
      'candidate-snapshot': getSnapshotRow({snapshotId: 'candidate-snapshot', status: 'candidate'}),
      'failed-snapshot': getSnapshotRow({
        lastError: 'projector failed',
        snapshotId: 'failed-snapshot',
        status: 'failed',
      }),
    },
  })
  const candidate = await readReviewServingRows(
    {...readyRequest, snapshotId: 'candidate-snapshot'},
    {database: reader.database, diagnosticsDatabase: manifestDatabase, manifestDatabase},
  )
  const failed = await readReviewServingRows(
    {...readyRequest, snapshotId: 'failed-snapshot'},
    {database: reader.database, diagnosticsDatabase: manifestDatabase, manifestDatabase},
  )

  expect(candidate).toMatchObject({reason: 'manifestStatusRejected', status: 'rejected'})
  expect(candidate.diagnostics.manifest).toMatchObject({freshness: 'indexing', status: 'candidate'})
  expect(failed).toMatchObject({reason: 'manifestStatusRejected', status: 'rejected'})
  expect(failed.diagnostics.manifest).toMatchObject({
    freshness: 'unavailable',
    lastError: 'projector failed',
    status: 'failed',
  })
  expect(reader.statements).toHaveLength(0)
})

test('readReviewServingRows rejects missing required component state before DuckDB execution', async () => {
  const reader = createReaderDatabase()
  const manifestDatabase = createManifestDatabase({
    bySnapshot: {
      'active-snapshot': getSnapshotRow({
        components: ['display', 'projectScope'],
        snapshotId: 'active-snapshot',
        status: 'active',
      }),
    },
  })
  const result = await readReviewServingRows(readyRequest, {
    database: reader.database,
    diagnosticsDatabase: manifestDatabase,
    manifestDatabase,
  })

  expect(result).toMatchObject({reason: 'missingRequiredComponentState', status: 'rejected'})
  expect(result.diagnostics.missingRequiredComponents).toContain('llmStatus')
  expect(reader.statements).toHaveLength(0)
})

test('readReviewServingRows validates cursors and filter signatures before DuckDB execution', async () => {
  const reader = createReaderDatabase()
  const manifestDatabase = createManifestDatabase({
    bySnapshot: {'active-snapshot': getSnapshotRow({snapshotId: 'active-snapshot', status: 'active'})},
  })
  const cursor = encodeReviewServingCursor({
    articleId: 'article-1',
    componentStates: getComponentState(llmRowComponents).required.reduce((states, state) => {
      return {
        ...states,
        [state.component]: {
          baseGeneration: state.baseGeneration,
          patchWatermark: state.patchWatermark,
          projectionIdentity: state.projectionIdentity,
        },
      }
    }, {}),
    contractKey: 'review.llm.rows',
    filterSignature: getReviewServingFilterSignature({filters: {}, searchTokenPrefix: 'abc'}),
    reviewConfigHash: 'config-1',
    snapshotId: 'active-snapshot',
    sortDirection: 'desc',
    sortKey: getReviewServingCursorSortKey(['sort_key DESC', 'article_id ASC']),
    sortValues: ['2026-01-01', 'article-1'],
    version: 1,
  })
  const result = await readReviewServingRows(
    {...readyRequest, cursor, searchTokenPrefix: 'xyz'},
    {database: reader.database, diagnosticsDatabase: manifestDatabase, manifestDatabase},
  )

  expect(result).toMatchObject({reason: 'filterSignatureMismatch', status: 'rejected'})
  expect(result.diagnostics.cursor).toEqual({reason: 'filterSignatureMismatch', valid: false})
  expect(reader.statements).toHaveLength(0)
})

test('readReviewServingRows applies ordered-prefix filters and mixed-direction cursor predicates', async () => {
  const reader = createReaderDatabase([{article_id: 'article-2', sort_key: '2026-01-02'}])
  const manifestDatabase = createManifestDatabase({
    bySnapshot: {
      'active-snapshot': getSnapshotRow({
        components: hydratedListComponents,
        snapshotId: 'active-snapshot',
        status: 'active',
      }),
    },
  })
  const filterInput = {
    filters: {
      articleCreatedAtFrom: '2026-01-01',
      articleCreatedAtTo: '2026-01-31',
      duplicateFlag: 'true',
      llmStatus: 'complete',
      promptAnswer: ['prompt-1:yes', 'prompt-2:no'],
      searchTokenPrefix: 'heart',
    },
    searchTokenPrefix: 'heart',
  }
  const cursor = encodeReviewServingCursor({
    articleId: 'article-1',
    componentStates: getComponentState(hydratedListComponents).required.reduce((states, state) => {
      return {
        ...states,
        [state.component]: {
          baseGeneration: state.baseGeneration,
          patchWatermark: state.patchWatermark,
          projectionIdentity: state.projectionIdentity,
        },
      }
    }, {}),
    contractKey: 'review.llm.rows',
    filterSignature: getReviewServingFilterSignature(filterInput),
    reviewConfigHash: 'config-1',
    snapshotId: 'active-snapshot',
    sortDirection: 'desc',
    sortKey: getReviewServingCursorSortKey(['sort_key DESC', 'article_id ASC']),
    sortValues: ['2026-01-01', 'article-1'],
    version: 1,
  })
  const result = await readReviewServingRows(
    {
      ...readyRequest,
      ...filterInput,
      cursor,
      searchMode: 'tokenPrefix',
      searchState: {availability: 'ready' as const, snapshotId: 'active-snapshot'},
    },
    {database: reader.database, diagnosticsDatabase: manifestDatabase, manifestDatabase},
  )
  const sql = reader.statements[0] ?? ''

  expect(result.status).toBe('accepted')
  expect(sql).toContain("article_created_at >= TIMESTAMPTZ '2026-01-01'")
  expect(sql).toContain("article_created_at < TIMESTAMPTZ '2026-02-01'")
  expect(sql).toContain('duplicate_flag = TRUE')
  expect(sql).toContain("llm_status_key = 'answered'")
  expect(sql).toContain('review:promptAnswer:prompt-1:yes')
  expect(sql).toContain('review:promptAnswer:prompt-2:no')
  expect(sql.match(/FROM mart\.review_article_filter_posting_serving_v4 filter_/gu)?.length).toBe(2)
  expect(sql).toContain('EXISTS (SELECT 1 FROM mart.review_title_search_serving_v4 search')
  expect(sql).toContain(
    "(sort_key < '2026-01-01') OR (sort_key IS NOT DISTINCT FROM '2026-01-01' AND article_id > 'article-1')",
  )
  expect(sql).not.toContain('(sort_key DESC')
  expect(sql).not.toContain('$cursor0')
})

test('readReviewServingRows serializes aliased detail list-mode priority cursors', async () => {
  const reader = createReaderDatabase([
    {article_id: 'article-2', list_mode_priority: 1, prompt_id: 'prompt-2', prompt_order: 2},
  ])
  const detailComponents: readonly ReviewServingProjectionComponent[] = [
    'humanStatus',
    'llmStatus',
    'summary',
    'payload',
  ]
  const manifestDatabase = createManifestDatabase({
    bySnapshot: {
      'active-snapshot': getSnapshotRow({
        components: detailComponents,
        snapshotId: 'active-snapshot',
        status: 'active',
      }),
    },
  })
  const result = await readReviewServingRows(
    {...readyRequest, articleId: 'article-2', contractKey: 'review.detail.judgments'},
    {database: reader.database, diagnosticsDatabase: manifestDatabase, manifestDatabase},
  )
  const cursor = result.status === 'accepted' ? result.getCursorForRow(result.rows[0] as Record<string, unknown>) : null
  const decoded = decodeReviewServingCursor(cursor)

  expect(result.status).toBe('accepted')
  expect(reader.statements[0]).toContain('AS list_mode_priority')
  expect(decoded.valid ? decoded.payload.sortValues : []).toEqual([1, 2, 'prompt-2'])
})

test('readReviewServingRows binds placeholders in a single pass', async () => {
  const reader = createReaderDatabase()
  const manifestDatabase = createManifestDatabase({
    bySnapshot: {'active-snapshot': getSnapshotRow({snapshotId: 'active-snapshot', status: 'active'})},
  })
  const result = await readReviewServingRows(
    {
      ...readyRequest,
      contractKey: 'review.search.substringAsync',
      jobFilterSignature: 'filters:1',
      limit: 1,
      searchMode: 'substringAsync',
      searchState: {availability: 'async' as const, jobId: 'search-job-1', reason: 'substring search runs async'},
      searchText: '$projectId',
    },
    {database: reader.database, diagnosticsDatabase: manifestDatabase, manifestDatabase},
  )
  const sql = reader.statements[0] ?? ''

  expect(result.status).toBe('accepted')
  expect(sql).toContain("'$projectId'")
  expect(sql).toContain("project_id = 'project-1'")
  expect(sql).not.toContain("''project-1''")
})

test('readReviewServingRows rejects unsupported filters before DuckDB execution', async () => {
  const reader = createReaderDatabase()
  const manifestDatabase = createManifestDatabase({
    bySnapshot: {'active-snapshot': getSnapshotRow({snapshotId: 'active-snapshot', status: 'active'})},
  })
  const result = await readReviewServingRows(
    {...readyRequest, filters: {sourceProject: 'project-2'}},
    {database: reader.database, diagnosticsDatabase: manifestDatabase, manifestDatabase},
  )

  expect(result).toMatchObject({reason: 'unsupportedFilterKey', status: 'rejected'})
  expect(reader.statements).toHaveLength(0)
})

test('readReviewServingRows requires supported count state before count SQL execution', async () => {
  const reader = createReaderDatabase([{value: 12}])
  const manifestDatabase = createManifestDatabase({
    bySnapshot: {
      'active-snapshot': getSnapshotRow({
        components: ['llmStatus', 'posting', 'queue', 'summary'],
        snapshotId: 'active-snapshot',
        status: 'active',
      }),
    },
  })
  const countRequest = {
    ...readyRequest,
    contractKey: 'review.llm.count',
    countFilterKey: 'prompt:1',
    countState: {
      availability: 'ready' as const,
      filterKey: 'prompt:1',
      key: 'review.llm.assessedByPrompt' as const,
      snapshotId: 'active-snapshot',
      value: 12,
    },
    limit: 1,
    namedCountKey: 'review.llm.assessedByPrompt' as const,
  }
  const accepted = await readReviewServingRows<{value: number}>(countRequest, {
    database: reader.database,
    diagnosticsDatabase: manifestDatabase,
    manifestDatabase,
  })
  const unavailable = await readReviewServingRows(
    {
      ...countRequest,
      countState: {
        availability: 'unavailable' as const,
        filterKey: 'prompt:1',
        key: 'review.llm.assessedByPrompt' as const,
        reason: 'count projector unavailable',
      },
    },
    {database: reader.database, diagnosticsDatabase: manifestDatabase, manifestDatabase},
  )
  const wrongFilterKey = await readReviewServingRows(
    {...countRequest, countFilterKey: 'prompt:2'},
    {database: reader.database, diagnosticsDatabase: manifestDatabase, manifestDatabase},
  )

  expect(accepted.status).toBe('accepted')
  expect(accepted.status === 'accepted' ? accepted.rows : []).toEqual([{value: 12}])
  expect(reader.statements[0]).toContain('FROM mart.review_article_count_serving_v4')
  expect(reader.statements[0]).toContain("count_kind = 'review.llm.assessedByPrompt'")
  expect(reader.statements[0]).toContain("filter_key = 'prompt:1'")
  expect(unavailable).toMatchObject({reason: 'admissionRejected', status: 'rejected'})
  expect(unavailable.diagnostics.admission?.rejectionReason).toBe('countStateUnavailable')
  expect(wrongFilterKey).toMatchObject({reason: 'admissionRejected', status: 'rejected'})
  expect(wrongFilterKey.diagnostics.admission?.rejectionReason).toBe('countStateUnavailable')
  expect(reader.statements).toHaveLength(1)
})

test('readReviewServingRows returns explicit async substring search state without raw scans', async () => {
  const reader = createReaderDatabase([{job_id: 'search-job-1'}])
  const manifestDatabase = createManifestDatabase({
    bySnapshot: {
      'active-snapshot': getSnapshotRow({
        components: ['projectScope'],
        snapshotId: 'active-snapshot',
        status: 'active',
      }),
    },
  })
  const result = await readReviewServingRows<{job_id: string}>(
    {
      ...readyRequest,
      contractKey: 'review.search.substringAsync',
      jobFilterSignature: 'filters:1',
      limit: 1,
      searchMode: 'substringAsync',
      searchState: {availability: 'async', jobId: 'search-job-1', reason: 'substring search runs async'},
      searchText: 'heart failure',
    },
    {database: reader.database, diagnosticsDatabase: manifestDatabase, manifestDatabase},
  )

  expect(result.status).toBe('accepted')
  expect(result.diagnostics.admission?.search.state).toMatchObject({availability: 'async', jobId: 'search-job-1'})
  expect(reader.statements).toHaveLength(1)
  expect(reader.statements[0]).toContain('FROM app.review_search_job')
  expect(reader.statements[0]).toContain("search_mode = 'substringAsync'")
  expect(reader.statements[0]).not.toContain('FROM app.article')
  expect(reader.workloads[0]).toMatchObject({fallbackIntent: 'async', searchMode: 'substringAsync'})
})

test('readReviewServingRows rejects mismatched and missing token-prefix search modes before DuckDB execution', async () => {
  const reader = createReaderDatabase()
  const readySearchManifestDatabase = createManifestDatabase({
    bySnapshot: {
      'active-snapshot': getSnapshotRow({
        components: ['projectScope', 'search'],
        snapshotId: 'active-snapshot',
        status: 'active',
      }),
    },
  })
  const missingSearchManifestDatabase = createManifestDatabase({
    bySnapshot: {
      'active-snapshot': getSnapshotRow({
        components: ['display', 'humanStatus', 'llmStatus', 'posting', 'projectScope', 'selectedImport', 'summary'],
        snapshotId: 'active-snapshot',
        status: 'active',
      }),
    },
  })
  const substringSync = await readReviewServingRows(
    {
      ...readyRequest,
      contractKey: 'review.search.tokenPrefix',
      limit: 10,
      searchMode: 'substringSync',
      searchTokenPrefix: 'hea',
    },
    {
      database: reader.database,
      diagnosticsDatabase: readySearchManifestDatabase,
      manifestDatabase: readySearchManifestDatabase,
    },
  )
  const missingSearchComponent = await readReviewServingRows(
    {
      ...readyRequest,
      contractKey: 'review.filters.facets',
      limit: 25,
      searchMode: 'tokenPrefix',
      searchState: {availability: 'ready', snapshotId: 'active-snapshot'},
      searchTokenPrefix: 'hea',
    },
    {
      database: reader.database,
      diagnosticsDatabase: missingSearchManifestDatabase,
      manifestDatabase: missingSearchManifestDatabase,
    },
  )

  expect(substringSync).toMatchObject({reason: 'admissionRejected', status: 'rejected'})
  expect(substringSync.diagnostics.admission?.rejectionReason).toBe('synchronousSubstringSearchUnavailable')
  expect(missingSearchComponent).toMatchObject({reason: 'missingRequiredComponentState', status: 'rejected'})
  expect(missingSearchComponent.diagnostics.missingRequiredComponents).toContain('search')
  expect(reader.statements).toHaveLength(0)
})

test('readReviewServingRows hydrates filtered lists through postings and article-set contracts without single-article lookups', async () => {
  const reader = createReaderDatabase([{article_id: 'article-1'}, {article_id: 'article-2'}])
  const manifestDatabase = createManifestDatabase({
    bySnapshot: {
      'active-snapshot': getSnapshotRow({
        components: hydratedListComponents,
        snapshotId: 'active-snapshot',
        status: 'active',
      }),
    },
  })
  const dependencies = {database: reader.database, diagnosticsDatabase: manifestDatabase, manifestDatabase}
  const postings = await readReviewServingRows(
    {
      ...readyRequest,
      contractKey: 'review.filters.postings',
      filterKind: 'promptAnswer',
      filterValue: 'include',
      limit: 2,
      listMode: 'both',
      searchMode: 'tokenPrefix',
      searchState: {availability: 'ready' as const, snapshotId: 'active-snapshot'},
      searchTokenPrefix: 'hea',
    },
    dependencies,
  )
  const rows = await readReviewServingRows(
    {
      ...readyRequest,
      articleIds: ['article-1', 'article-2'],
      contractKey: 'review.both.rowsByArticleSet',
      estimatedHydratedPayloadBytes: 12_000,
      estimatedResultBytes: 40_000,
      limit: 2,
    },
    dependencies,
  )
  const judgments = await readReviewServingRows(
    {
      ...readyRequest,
      articleIds: ['article-1', 'article-2'],
      contractKey: 'review.both.list.judgments',
      estimatedHydratedPayloadBytes: 120_000,
      estimatedResultBytes: 200_000,
      limit: 100,
    },
    dependencies,
  )

  expect(postings.status).toBe('accepted')
  expect(rows.status).toBe('accepted')
  expect(judgments.status).toBe('accepted')
  expect(reader.statements).toHaveLength(3)
  expect(reader.statements[0]).toContain('FROM mart.review_article_filter_posting_serving_v4')
  expect(reader.statements[0]).toContain('EXISTS (SELECT 1 FROM mart.review_title_search_serving_v4 search')
  expect(reader.statements[1]).toContain('FROM mart.review_article_serving_v4')
  expect(reader.statements[1]).toContain("AND list_mode_key = 'both'")
  expect(reader.statements[1]).toContain("AND article_id IN (SELECT unnest(['article-1', 'article-2']::VARCHAR[]))")
  expect(reader.statements[1]).toContain('ORDER BY sort_key DESC, article_id ASC LIMIT 2')
  expect(reader.statements[2]).toContain('FROM mart.review_article_judgment_detail_serving_v4')
  expect(reader.statements[2]).toContain("AND article_id IN (SELECT unnest(['article-1', 'article-2']::VARCHAR[]))")
  expect(reader.statements[2]).toContain('ORDER BY article_id ASC, prompt_order ASC NULLS LAST, prompt_id ASC')
  expect(reader.statements.join('\n')).not.toContain('article_id = $articleId')
  expect(reader.statements.join('\n')).not.toContain('selected_scoped_article_import')
})

test('readReviewServingRows rejects article-set hydration over article ID and payload byte caps', async () => {
  const reader = createReaderDatabase()
  const manifestDatabase = createManifestDatabase({
    bySnapshot: {
      'active-snapshot': getSnapshotRow({
        components: hydratedListComponents,
        snapshotId: 'active-snapshot',
        status: 'active',
      }),
    },
  })
  const dependencies = {database: reader.database, diagnosticsDatabase: manifestDatabase, manifestDatabase}
  const tooManyArticleIds = await readReviewServingRows(
    {
      ...readyRequest,
      articleIds: Array.from({length: 101}, (_value, index) => {
        return `article-${index}`
      }),
      contractKey: 'review.llm.rowsByArticleSet',
      estimatedHydratedPayloadBytes: 1_000,
      limit: 100,
    },
    dependencies,
  )
  const tooManyPayloadBytes = await readReviewServingRows(
    {
      ...readyRequest,
      articleIds: ['article-1'],
      contractKey: 'review.llm.list.judgments',
      estimatedHydratedPayloadBytes: 2_000_001,
      limit: 100,
    },
    dependencies,
  )

  expect(tooManyArticleIds).toMatchObject({reason: 'articleSetBoundsRejected', status: 'rejected'})
  expect(tooManyPayloadBytes).toMatchObject({reason: 'articleSetBoundsRejected', status: 'rejected'})
  expect(reader.statements).toHaveLength(0)
})
