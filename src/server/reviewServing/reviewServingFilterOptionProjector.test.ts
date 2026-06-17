import {expect, test} from 'bun:test'

import {type ReviewServingDirtyWorkClaim} from './reviewServingDirtyWorkService.ts'
import {
  getReviewServingFilterOptionIdentity,
  projectReviewServingFilterOptions,
  type ReviewServingFilterOptionProjectorDatabase,
} from './reviewServingFilterOptionProjector.ts'

const optionClaim = (input?: Partial<ReviewServingDirtyWorkClaim>): ReviewServingDirtyWorkClaim => {
  return {
    articleId: 'article-1',
    dirtyKind: 'judgment.llm.updated',
    dirtyRangeEnd: null,
    dirtyRangeStart: null,
    dirtyWorkId: 'dirty-work-1',
    firstSourceHighWaterMark: 10,
    latestDeltaId: 'delta-1',
    latestSourceHighWaterMark: 12,
    projectId: 'project-1',
    projectionComponent: 'summary',
    projectionIdentity: 'filter-option:identity-1',
    scopeId: 'project-1:article-1',
    scopeKind: 'article',
    sourcePartition: 'review-filter-option:article-1',
    status: 'running',
    ...input,
  }
}

const projectInput = (input?: {
  claims?: readonly ReviewServingDirtyWorkClaim[]
  filterOptionIdentity?: string
  listModeKeys?: readonly string[]
  optionMode?: 'human' | 'review'
  searchIdentity?: string
  searchTitle?: string | null
}) => {
  return {
    claims: input?.claims ?? [optionClaim()],
    baseGeneration: 5,
    definitionVersion: 'summary-v1-test',
    filterOptionIdentity: input?.filterOptionIdentity ?? 'filter-option:identity-1',
    listModeKeys: input?.listModeKeys ?? ['llm'],
    optionMode: input?.optionMode ?? 'review',
    projectId: 'project-1',
    projectionIdentity: 'filter-option:identity-1',
    reviewConfigHash: 'review-config-1',
    searchIdentity: input?.searchIdentity ?? 'search:none',
    searchTitle: input?.searchTitle,
    snapshotId: 'snapshot-1',
  }
}

const sourceRow = (input?: Record<string, unknown>) => {
  return {
    answerId: null,
    countValue: 3,
    facetKey: 'promptAnswer',
    facetValue: 'yes',
    filterKind: 'review',
    numericMax: null,
    numericMin: null,
    optionPayloadJson: {filterType: 'enum', promptId: 'prompt-1', value: 'yes'},
    optionValueKey: 'review:promptAnswer:prompt-1:yes',
    promptId: 'prompt-1',
    ...input,
  }
}

const createFilterOptionDatabase = (input?: {sourceRows?: readonly Record<string, unknown>[]}) => {
  const statements: string[] = []
  const database: ReviewServingFilterOptionProjectorDatabase = {
    queryJson: async <T>(statement: string) => {
      statements.push(statement)

      if (statement.includes('review_facet_options')) {
        return (input?.sourceRows ?? []) as T[]
      }

      return [] as T[]
    },
    run: async (statement: string) => {
      statements.push(statement)
    },
    transaction: async (operation) => {
      return operation(database)
    },
  }

  return {database, statements}
}

const hasOptionValue = (rows: readonly Record<string, unknown>[], expected: Record<string, unknown>) => {
  return rows.some((row) => {
    return Object.entries(expected).every(([key, value]) => {
      return row[key] === value
    })
  })
}

test('projects supported enum option payloads into scoped option rows', async () => {
  const {database, statements} = createFilterOptionDatabase({
    sourceRows: [sourceRow()],
  })

  const result = await projectReviewServingFilterOptions(projectInput(), database)
  const joined = statements.join('\n')

  expect(result.optionRowCount).toBe(1)
  expect(
    hasOptionValue(result.optionValues, {
      count_value: 3,
      facet_key: 'promptAnswer',
      facet_value: 'yes',
      filter_kind: 'review',
      option_value_key: 'review:promptAnswer:prompt-1:yes',
      prompt_id: 'prompt-1',
    }),
  ).toBe(true)
  expect(joined).toContain('DELETE FROM mart.review_filter_option_serving_v4')
  expect(joined).toContain('INSERT INTO mart.review_filter_option_serving_v4')
  expect(joined.indexOf('INSERT INTO mart.review_filter_option_serving_v4')).toBeLessThan(
    joined.indexOf('INSERT INTO app.review_projection_identity_manifest'),
  )
  expect(joined).not.toContain('numericPromptAnswer')
  expect(joined).not.toContain('numeric_options')
})

test('source query preserves active search and filter scope without using posting rows as response rows', async () => {
  const {database, statements} = createFilterOptionDatabase({sourceRows: [sourceRow()]})

  await projectReviewServingFilterOptions(
    projectInput({
      filterOptionIdentity: 'identity:search',
      listModeKeys: ['llm', 'human'],
      searchIdentity: 'search:title',
      searchTitle: 'heart',
    }),
    database,
  )
  const sourceStatement = statements.find((statement) => {
    return statement.includes('active_article')
  })
  const joined = statements.join('\n')

  expect(sourceStatement).toContain('mart.review_article_serving_v4 serving')
  expect(sourceStatement).toContain("LIKE LOWER('%heart%')")
  expect(sourceStatement).toContain("('llm'), ('human')")
  expect(sourceStatement).toContain('mart.review_article_judgment_detail_serving_v4 detail')
  expect(sourceStatement).toContain('detail.answered_original AS answerValue')
  expect(sourceStatement).toContain('unnest(detail.answered_original_as_array) AS answerValue')
  expect(sourceStatement).not.toContain('mart.review_article_filter_posting_serving_v4')
  expect(joined).toContain("search_identity IS NOT DISTINCT FROM 'search:title'")
  expect(joined).toContain("filter_option_identity IS NOT DISTINCT FROM 'identity:search'")
})

test('human option projection keeps prompt answers separate from summary-mode answers', async () => {
  const {database, statements} = createFilterOptionDatabase({
    sourceRows: [
      sourceRow({
        facetKey: 'promptAnswer',
        filterKind: 'human',
        optionPayloadJson: {filterType: 'enum', promptId: 'prompt-1', value: 'yes'},
        optionValueKey: 'human:promptAnswer:prompt-1:yes',
        promptId: 'prompt-1',
      }),
      sourceRow({
        facetKey: 'promptAnswer',
        filterKind: 'human',
        optionPayloadJson: {filterType: 'enum', promptId: 'summary', summaryMode: true, value: 'include'},
        optionValueKey: 'human:promptAnswer:summary:include',
        promptId: 'summary',
      }),
    ],
  })

  const result = await projectReviewServingFilterOptions(projectInput({optionMode: 'human'}), database)
  const sourceStatement = statements.find((statement) => {
    return statement.includes('human_summary_options')
  })

  expect(sourceStatement).toContain("detail.payload_kind = 'human'")
  expect(sourceStatement).toContain("'promptAnswer' AS facetKey")
  expect(sourceStatement).toContain("answer.prompt_id = 'summary'")
  expect(sourceStatement).toContain("answer.prompt_id <> 'summary'")
  expect(
    hasOptionValue(result.optionValues, {
      facet_key: 'promptAnswer',
      filter_kind: 'human',
      option_value_key: 'human:promptAnswer:prompt-1:yes',
      prompt_id: 'prompt-1',
    }),
  ).toBe(true)
  expect(
    hasOptionValue(result.optionValues, {
      facet_key: 'promptAnswer',
      filter_kind: 'human',
      option_value_key: 'human:promptAnswer:summary:include',
      prompt_id: 'summary',
    }),
  ).toBe(true)
})

test('filter option identity includes mode, list modes, search scope, filter keys, and summary versions', () => {
  const reviewIdentity = getReviewServingFilterOptionIdentity({
    filterKeys: ['promptAnswer', 'publicationYear'],
    listModeKeys: ['human', 'llm'],
    optionMode: 'review',
    searchIdentity: 'search:none',
  })
  const humanIdentity = getReviewServingFilterOptionIdentity({
    filterKeys: ['promptAnswer', 'publicationYear'],
    listModeKeys: ['human', 'llm'],
    optionMode: 'human',
    searchIdentity: 'search:none',
  })
  const oldVersionIdentity = getReviewServingFilterOptionIdentity({
    filterKeys: ['promptAnswer', 'publicationYear'],
    listModeKeys: ['human', 'llm'],
    optionMode: 'review',
    searchIdentity: 'search:none',
    summaryDefinitionVersions: {promptAnswer: 'old-summary:v0'},
  })

  expect(reviewIdentity).toContain('review-filter-prompt-answer:v1')
  expect(reviewIdentity).toContain('search:none')
  expect(reviewIdentity).toContain('llm')
  expect(reviewIdentity).not.toBe(humanIdentity)
  expect(reviewIdentity).not.toBe(oldVersionIdentity)
})
