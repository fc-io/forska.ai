import {expect, test} from 'bun:test'

import {
  getReviewServingFilteredCountComponentIdentities,
  getReviewServingFilteredCountComponentRevisionReadSql,
  getReviewServingFilteredCountPruneSql,
  getReviewServingFilteredCountReadSql,
  getReviewServingFilteredCountSignature,
  getReviewServingFilteredCountValue,
  getReviewServingFilteredCountWriteSqls,
  type ReviewServingFilteredCountDatabase,
  type ReviewServingFilteredCountLookup,
} from './reviewServingFilteredCountService.ts'
import type {ReviewServingSnapshotManifest} from './reviewServingManifestRepository.ts'

const lookup: ReviewServingFilteredCountLookup = {
  componentIdentity: 'component-identity',
  filterSignature: getReviewServingFilteredCountSignature({
    filters: {promptAnswer: ['yes', 'yes'], searchTokenPrefix: 'heart'},
    searchTokenPrefixes: ['heart', 'failure'],
  }),
  listModeKey: 'llm',
  projectId: 'project-1',
  reviewConfigHash: 'config-1',
  snapshotId: 'snapshot-1',
}

const getManifest = (input: {
  payloadIdentity: string
  postingIdentity?: string
  postingPatchWatermark?: string
}): ReviewServingSnapshotManifest => {
  const postingIdentity = input.postingIdentity ?? 'posting:identity-1'
  const postingPatchWatermark = input.postingPatchWatermark ?? '2'

  return {
    componentRequirements: {
      optionalComponents: ['payload', 'search'],
      requiredComponents: ['projectScope', 'selectedImport', 'display', 'llmStatus', 'posting', 'summary'],
    },
    componentState: {
      optional: [
        {
          baseGeneration: '1',
          component: 'payload',
          patchWatermark: '2',
          projectionIdentity: input.payloadIdentity,
          requirement: 'optional',
        },
        {
          baseGeneration: '1',
          component: 'search',
          patchWatermark: '2',
          projectionIdentity: 'search:identity-1',
          requirement: 'optional',
        },
      ],
      required: (
        [
          ['projectScope', 'projectScope:identity-1'],
          ['selectedImport', 'selectedImport:identity-1'],
          ['display', 'display:identity-1'],
          ['llmStatus', 'llmStatus:identity-1'],
          ['posting', postingIdentity],
          ['summary', 'summary:identity-1'],
        ] as const
      ).map(([component, projectionIdentity]) => {
        return {
          baseGeneration: '1',
          component,
          patchWatermark: component === 'posting' ? postingPatchWatermark : '2',
          projectionIdentity,
          requirement: 'required' as const,
        }
      }),
    },
    composedIdentity: {},
    lastError: null,
    lastKnownGoodSnapshotId: null,
    optionalComponents: ['payload', 'search'],
    projectId: 'project-1',
    requiredComponents: ['projectScope', 'selectedImport', 'display', 'llmStatus', 'posting', 'summary'],
    reviewConfigHash: 'config-1',
    selectedImportSnapshotId: 'selected-import-1',
    snapshotId: 'snapshot-1',
    sourceWatermarks: {},
    status: 'active',
    validationResult: null,
  }
}

test('filtered count serving read SQL only touches the memoized count table', () => {
  const sql = getReviewServingFilteredCountReadSql(lookup)

  expect(sql).toContain('FROM mart.review_filtered_count_serving_v4')
  expect(sql).toContain('filter_signature =')
  expect(sql).toContain('component_identity =')
  expect(sql).not.toContain('review_article_filter_posting_serving_v4')
  expect(sql).not.toContain('review_title_search_serving_v4')
  expect(sql).not.toContain('review_unassessed_queue_serving_v4')
  expect(sql).not.toContain('review_article_judgment_detail_serving_v4')
})

test('filtered count serving write records composed component identity without indexed upsert', () => {
  const writeSqls = getReviewServingFilteredCountWriteSqls({...lookup, countValue: 42})
  const writeSql = writeSqls.join('\n')
  const pruneSql = getReviewServingFilteredCountPruneSql({...lookup, maxRowsPerScope: 17})

  expect(writeSqls).toHaveLength(2)
  expect(writeSql).toContain('DELETE FROM mart.review_filtered_count_serving_v4')
  expect(writeSql).toContain('INSERT INTO mart.review_filtered_count_serving_v4')
  expect(writeSql).toContain('component_identity')
  expect(writeSql).not.toContain('project_scope_identity')
  expect(writeSql).not.toContain('search_identity')
  expect(writeSql).not.toContain('posting_identity')
  expect(writeSql).not.toContain('queue_identity')
  expect(writeSql).not.toContain('payload_identity')
  expect(writeSql).not.toContain('ON CONFLICT')
  expect(writeSql).not.toContain('excluded.')
  expect(pruneSql).toContain('ROW_NUMBER() OVER')
  expect(pruneSql).toContain('row_rank > 17')
})

test('filtered count component identities ignore payload churn and track count dependencies', () => {
  const components = ['display', 'projectScope', 'selectedImport', 'llmStatus', 'posting', 'search', 'payload'] as const
  const payloadV1 = getReviewServingFilteredCountComponentIdentities(
    getManifest({payloadIdentity: 'payload:identity-1'}),
    components,
  )
  const payloadV2 = getReviewServingFilteredCountComponentIdentities(
    getManifest({payloadIdentity: 'payload:identity-2'}),
    components,
  )
  const postingV2 = getReviewServingFilteredCountComponentIdentities(
    getManifest({payloadIdentity: 'payload:identity-2', postingIdentity: 'posting:identity-2'}),
    components,
  )
  const postingWatermarkV2 = getReviewServingFilteredCountComponentIdentities(
    getManifest({payloadIdentity: 'payload:identity-2', postingPatchWatermark: '3'}),
    components,
  )

  expect(payloadV2.componentIdentity).toBe(payloadV1.componentIdentity)
  expect(postingV2.componentIdentity).not.toBe(payloadV1.componentIdentity)
  expect(postingWatermarkV2.componentIdentity).not.toBe(payloadV1.componentIdentity)
})

test('filtered count component revision SQL reads bounded dependency revisions', () => {
  const revisionSql = getReviewServingFilteredCountComponentRevisionReadSql({
    ...lookup,
    ...getReviewServingFilteredCountComponentIdentities(getManifest({payloadIdentity: 'payload:identity-1'}), [
      'display',
      'llmStatus',
      'posting',
      'search',
    ]),
  })

  expect(revisionSql).toContain('WITH requested_component')
  expect(revisionSql).toContain('LEFT JOIN app.review_projection_identity_manifest projection')
  expect(revisionSql).toContain('LEFT JOIN app.review_serving_component_revision component_revision')
  expect(revisionSql).toContain("component_revision.snapshot_id IS NOT DISTINCT FROM 'snapshot-1'")
  expect(revisionSql).toContain("component_revision.list_mode_key IS NOT DISTINCT FROM 'llm'")
  expect(revisionSql).toContain('MAX(component_revision.revision) AS servingRevision')
  expect(revisionSql).not.toContain('FROM app.review_serving_dirty_work')
})

test('filtered count serving misses stale positive cache rows after component revision changes', async () => {
  const componentIdentity = getReviewServingFilteredCountComponentIdentities(
    getManifest({payloadIdentity: 'payload:identity-1'}),
    ['display', 'llmStatus'],
  ).componentIdentity
  const statements: string[] = []
  const database: ReviewServingFilteredCountDatabase = {
    queryJson: async <T>(statement: string): Promise<T[]> => {
      statements.push(statement)

      if (statement.includes('LEFT JOIN app.review_projection_identity_manifest projection')) {
        return [
          {
            baseGeneration: '1',
            component: 'display',
            manifestPatchWatermark: '2',
            projectionIdentity: 'display:identity-1',
            projectionInputWatermark: 2,
            projectionInputWatermarksJson: {reviewChange: 2},
            projectionPatchWatermark: 2,
            servingRevision: null,
            servingSourceHighWaterMark: null,
          },
          {
            baseGeneration: '1',
            component: 'llmStatus',
            manifestPatchWatermark: '2',
            projectionIdentity: 'llmStatus:identity-1',
            projectionInputWatermark: 14,
            projectionInputWatermarksJson: {reviewChange: 14},
            projectionPatchWatermark: 14,
            servingRevision: 3,
            servingSourceHighWaterMark: 14,
          },
        ] as T[]
      }

      if (
        statement.includes('FROM mart.review_filtered_count_serving_v4')
        && statement.includes(`component_identity = '${componentIdentity}'`)
      ) {
        return [{countFound: true, countValue: 450}] as T[]
      }

      return [] as T[]
    },
    run: async (statement: string) => {
      statements.push(statement)
    },
  }

  const value = await getReviewServingFilteredCountValue({
    ...lookup,
    componentIdentity,
    computeCount: async () => {
      return 451
    },
    database,
  })
  const cacheRead = statements.find((statement) => {
    return statement.includes('FROM mart.review_filtered_count_serving_v4')
  })

  expect(value).toBe(451)
  expect(cacheRead).toBeDefined()
  expect(cacheRead).not.toContain(`component_identity = '${componentIdentity}'`)
  expect(statements.join('\n')).toContain('INSERT INTO mart.review_filtered_count_serving_v4')
  expect(statements.join('\n')).toContain('servingRevision')
})

test('filtered count serving returns cache hits without computing or writing', async () => {
  const statements: string[] = []
  const database: ReviewServingFilteredCountDatabase = {
    queryJson: async <T>(statement: string): Promise<T[]> => {
      statements.push(statement)

      return [{countFound: true, countValue: 9}] as T[]
    },
    run: async (statement: string) => {
      statements.push(statement)
    },
  }
  let computed = false

  const value = await getReviewServingFilteredCountValue({
    ...lookup,
    computeCount: async () => {
      computed = true
      return 42
    },
    database,
  })

  expect(value).toBe(9)
  expect(computed).toBe(false)
  expect(statements).toHaveLength(1)
  expect(statements[0]).not.toContain('review_article_filter_posting_serving_v4')
})

test('filtered count serving treats cached zero as provisional and recomputes', async () => {
  const statements: string[] = []
  const database: ReviewServingFilteredCountDatabase = {
    queryJson: async <T>(statement: string): Promise<T[]> => {
      statements.push(statement)

      return [{countFound: true, countValue: 0}] as T[]
    },
    run: async (statement: string) => {
      statements.push(statement)
    },
  }

  const value = await getReviewServingFilteredCountValue({
    ...lookup,
    computeCount: async () => {
      return 42
    },
    database,
  })

  expect(value).toBe(42)
  expect(statements).toHaveLength(4)
  expect(statements[1]).toContain('DELETE FROM mart.review_filtered_count_serving_v4')
  expect(statements[2]).toContain('INSERT INTO mart.review_filtered_count_serving_v4')
})

test('filtered count serving does not memoize zero misses', async () => {
  const statements: string[] = []
  const database: ReviewServingFilteredCountDatabase = {
    queryJson: async <T>(statement: string): Promise<T[]> => {
      statements.push(statement)

      return [] as T[]
    },
    run: async (statement: string) => {
      statements.push(statement)
    },
  }

  const value = await getReviewServingFilteredCountValue({
    ...lookup,
    computeCount: async () => {
      return 0
    },
    database,
  })

  expect(value).toBe(0)
  expect(statements).toHaveLength(1)
  expect(statements[0]).toContain('FROM mart.review_filtered_count_serving_v4')
})

test('filtered count serving fills and bounds after a miss', async () => {
  const statements: string[] = []
  const database: ReviewServingFilteredCountDatabase = {
    queryJson: async <T>(statement: string): Promise<T[]> => {
      statements.push(statement)

      return [] as T[]
    },
    run: async (statement: string) => {
      statements.push(statement)
    },
  }

  const value = await getReviewServingFilteredCountValue({
    ...lookup,
    computeCount: async () => {
      return 42
    },
    database,
    maxRowsPerScope: 3,
  })

  expect(value).toBe(42)
  expect(statements).toHaveLength(4)
  expect(statements[0]).toContain('FROM mart.review_filtered_count_serving_v4')
  expect(statements[1]).toContain('DELETE FROM mart.review_filtered_count_serving_v4')
  expect(statements[2]).toContain('INSERT INTO mart.review_filtered_count_serving_v4')
  expect(statements[3]).toContain('row_rank > 3')
})
