import {expect, test} from 'bun:test'

import type {DuckdbWorkloadContext} from '../utils/duckdbService.ts'
import type {ReviewServingProjectionComponent, ReviewServingSnapshotStatus} from './reviewServingContracts.ts'
import {
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
  expect(reader.statements[0]).toContain('WHERE project_id = $projectId')
  expect(reader.statements[0]).toContain('snapshot_id = $snapshotId')
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
