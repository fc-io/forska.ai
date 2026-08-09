import {expect, test} from 'bun:test'

import {
  getReviewServingFilteredCountComponentIdentities,
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

const getManifest = (
  payloadIdentity: string,
  postingIdentity = 'posting:identity-1',
): ReviewServingSnapshotManifest => {
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
          projectionIdentity: payloadIdentity,
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
          patchWatermark: '2',
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
  const payloadV1 = getReviewServingFilteredCountComponentIdentities(getManifest('payload:identity-1'), components)
  const payloadV2 = getReviewServingFilteredCountComponentIdentities(getManifest('payload:identity-2'), components)
  const postingV2 = getReviewServingFilteredCountComponentIdentities(
    getManifest('payload:identity-2', 'posting:identity-2'),
    components,
  )

  expect(payloadV2.componentIdentity).toBe(payloadV1.componentIdentity)
  expect(postingV2.componentIdentity).not.toBe(payloadV1.componentIdentity)
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
