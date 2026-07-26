import {expect, test} from 'bun:test'

import {
  getReviewServingFilteredCountPruneSql,
  getReviewServingFilteredCountReadSql,
  getReviewServingFilteredCountSignature,
  getReviewServingFilteredCountUpsertSql,
  getReviewServingFilteredCountValue,
  type ReviewServingFilteredCountDatabase,
  type ReviewServingFilteredCountLookup,
} from './reviewServingFilteredCountService.ts'

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

test('filtered count serving upsert records composed component identity and prunes bounded scope', () => {
  const upsertSql = getReviewServingFilteredCountUpsertSql({...lookup, countValue: 42})
  const pruneSql = getReviewServingFilteredCountPruneSql({...lookup, maxRowsPerScope: 17})

  expect(upsertSql).toContain('INSERT INTO mart.review_filtered_count_serving_v4')
  expect(upsertSql).toContain('component_identity')
  expect(upsertSql).not.toContain('project_scope_identity')
  expect(upsertSql).not.toContain('search_identity')
  expect(upsertSql).not.toContain('posting_identity')
  expect(upsertSql).not.toContain('queue_identity')
  expect(upsertSql).not.toContain('payload_identity')
  expect(upsertSql).toContain(
    'ON CONFLICT(project_id, review_config_hash, snapshot_id, list_mode_key, filter_signature, component_identity)',
  )
  expect(upsertSql).toContain('count_updated_at = now()')
  expect(pruneSql).toContain('ROW_NUMBER() OVER')
  expect(pruneSql).toContain('row_rank > 17')
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
  expect(statements).toHaveLength(3)
  expect(statements[0]).toContain('FROM mart.review_filtered_count_serving_v4')
  expect(statements[1]).toContain('INSERT INTO mart.review_filtered_count_serving_v4')
  expect(statements[2]).toContain('row_rank > 3')
})
