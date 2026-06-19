import {expect, test} from 'bun:test'

import type {DuckdbWorkloadContext} from '../utils/duckdbService.ts'
import {type ReviewSearchServiceDatabase, searchReviewServing} from './reviewSearchService.ts'
import type {ReviewServingProjectionComponent, ReviewServingSnapshotStatus} from './reviewServingContracts.ts'
import type {ReviewServingManifestRepositoryDatabase} from './reviewServingManifestRepository.ts'

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
  snapshotId?: string
  status: ReviewServingSnapshotStatus
}) => {
  const components = input.components ?? ['projectScope', 'search']

  return {
    componentStateJson: getComponentState(components),
    composedIdentityJson: {snapshot: input.snapshotId ?? `${input.status}-snapshot`},
    lastError: null,
    lastKnownGoodSnapshotId: null,
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
  return statement.includes('GROUP BY snapshot_status') ? [{snapshotCount: 1, snapshotStatus: 'active'}] : []
}

const createManifestDatabase = (bySnapshot: Record<string, unknown>) => {
  const database: ReviewServingManifestRepositoryDatabase = {
    queryJson: async <T>(statement: string): Promise<T[]> => {
      if (!statement.includes('FROM app.review_serving_snapshot_manifest')) {
        return getDiagnosticsRows(statement) as T[]
      }

      const match = statement.match(/snapshot_id = '([^']+)'/u)
      const snapshot = match ? bySnapshot[match[1] ?? ''] : null

      return snapshot ? ([snapshot] as T[]) : []
    },
    run: async () => {},
    transaction: async (operation) => {
      return operation(database)
    },
  }

  return database
}

const createSearchDatabase = (rows: readonly unknown[] = [{article_id: 'article-1', token: 'heart'}]) => {
  const runs: string[] = []
  const statements: string[] = []
  const workloads: unknown[] = []
  const database: ReviewSearchServiceDatabase = {
    queryJson: async <T>(statement: string, workloadContext?: DuckdbWorkloadContext): Promise<T[]> => {
      statements.push(statement)
      workloads.push(workloadContext)

      return rows as T[]
    },
    run: async (statement: string) => {
      runs.push(statement)
    },
  }

  return {database, runs, statements, workloads}
}

const readySearchRequest = {
  limit: 10,
  projectId: 'project-1',
  reviewConfigHash: 'config-1',
  searchMode: 'tokenPrefix' as const,
  searchText: 'hea',
  snapshotId: 'active-snapshot',
}

test('searchReviewServing serves token-prefix search from ready search contracts', async () => {
  const searchDatabase = createSearchDatabase()
  const manifestDatabase = createManifestDatabase({
    'active-snapshot': getSnapshotRow({snapshotId: 'active-snapshot', status: 'active'}),
  })
  const result = await searchReviewServing(readySearchRequest, {database: searchDatabase.database, manifestDatabase})

  expect(result.status).toBe('ready')
  expect(result.status === 'ready' ? result.rows : []).toEqual([{article_id: 'article-1', token: 'heart'}])
  expect(searchDatabase.statements).toHaveLength(1)
  expect(searchDatabase.statements[0]).toContain('FROM mart.review_title_search_serving_v4')
  expect(searchDatabase.statements[0]).toContain("search_identity = 'search-identity'")
  expect(searchDatabase.statements[0]).toContain("project_scope_identity = 'projectScope-identity'")
  expect(searchDatabase.statements[0]).toContain("snapshot_id = 'active-snapshot'")
  expect(searchDatabase.statements[0]).toContain("starts_with(token, 'hea')")
  expect(searchDatabase.statements[0]).not.toContain('LIKE')
  expect(searchDatabase.workloads[0]).toMatchObject({
    fallbackIntent: 'reject',
    routeOrJobKey: 'review.search.tokenPrefix',
    searchMode: 'tokenPrefix',
  })
})

test('searchReviewServing creates bounded async substring work without synchronous title scans', async () => {
  const searchDatabase = createSearchDatabase([{job_id: 'existing-job'}])
  const manifestDatabase = createManifestDatabase({
    'active-snapshot': getSnapshotRow({snapshotId: 'active-snapshot', status: 'active'}),
  })
  const result = await searchReviewServing(
    {...readySearchRequest, createAsyncWork: true, searchMode: 'substring', searchText: 'heart failure'},
    {database: searchDatabase.database, manifestDatabase},
  )

  expect(result.status).toBe('async')
  expect(result.status === 'async' ? result.diagnostics.jobId : '').toStartWith('review-search-')
  expect(searchDatabase.runs).toHaveLength(1)
  expect(searchDatabase.runs[0]).toContain('INSERT INTO app.review_search_job')
  expect(searchDatabase.runs[0]).toContain("'substringAsync'")
  expect(searchDatabase.runs[0]).toContain('{"cursor":null,"limit":500}')
  expect(searchDatabase.statements).toHaveLength(1)
  expect(searchDatabase.statements[0]).toContain('FROM app.review_search_job')
  expect(searchDatabase.statements[0]).toContain("search_mode = 'substringAsync'")
  expect(searchDatabase.statements[0]).not.toContain('mart.review_title_search_serving_v4')
  expect(searchDatabase.statements[0]).not.toContain('app.article')
  expect(searchDatabase.statements[0]).not.toContain('LIKE')
  expect(searchDatabase.workloads[0]).toMatchObject({fallbackIntent: 'async', searchMode: 'substringAsync'})
})

test('searchReviewServing returns indexing substring state before DuckDB when snapshot is not ready', async () => {
  const searchDatabase = createSearchDatabase()
  const manifestDatabase = createManifestDatabase({
    'candidate-snapshot': getSnapshotRow({snapshotId: 'candidate-snapshot', status: 'candidate'}),
  })
  const result = await searchReviewServing(
    {...readySearchRequest, createAsyncWork: true, searchMode: 'substring', snapshotId: 'candidate-snapshot'},
    {database: searchDatabase.database, manifestDatabase},
  )

  expect(result).toMatchObject({status: 'indexing'})
  expect(searchDatabase.runs).toHaveLength(0)
  expect(searchDatabase.statements).toHaveLength(0)
})

test('searchReviewServing returns unavailable substring state when async work is not requested and no job exists', async () => {
  const searchDatabase = createSearchDatabase([])
  const manifestDatabase = createManifestDatabase({
    'active-snapshot': getSnapshotRow({snapshotId: 'active-snapshot', status: 'active'}),
  })
  const result = await searchReviewServing(
    {...readySearchRequest, searchMode: 'substring', searchText: 'heart failure'},
    {database: searchDatabase.database, manifestDatabase},
  )

  expect(result).toMatchObject({status: 'unavailable'})
  expect(searchDatabase.runs).toHaveLength(0)
  expect(searchDatabase.statements).toHaveLength(1)
  expect(searchDatabase.statements[0]).toContain('FROM app.review_search_job')
  expect(searchDatabase.statements[0]).not.toContain('LIKE')
})
