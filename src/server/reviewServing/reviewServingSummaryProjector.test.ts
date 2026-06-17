import {expect, test} from 'bun:test'

import {type ReviewServingDirtyWorkClaim} from './reviewServingDirtyWorkService.ts'
import {
  projectReviewServingSummaries,
  type ReviewServingSummaryProjectorDatabase,
} from './reviewServingSummaryProjector.ts'

const summaryClaim = (input?: Partial<ReviewServingDirtyWorkClaim>): ReviewServingDirtyWorkClaim => {
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
    projectionIdentity: 'summary:identity-1',
    scopeId: 'project-1:article-1',
    scopeKind: 'article',
    sourcePartition: 'review-summary:article-1',
    status: 'running',
    ...input,
  }
}

const projectInput = (claims: readonly ReviewServingDirtyWorkClaim[], listModeKeys: readonly string[] = ['llm']) => {
  return {
    baseGeneration: 5,
    claims,
    listModeKeys,
    projectId: 'project-1',
    projectScopeIdentity: 'project-scope-1',
    projectionIdentity: 'summary:identity-1',
    reviewConfigHash: 'review-config-1',
    selectedImportSnapshotId: 'selected-snapshot-1',
    snapshotId: 'snapshot-1',
  }
}

const contributionKey = (input: Record<string, unknown>) => {
  return JSON.stringify(input, Object.keys(input).sort())
}

const sourceCountRow = (input?: Record<string, unknown>) => {
  return {
    answerId: null,
    answerValue: null,
    articleId: 'article-1',
    availability: 'ready',
    countKind: 'review.llm.assessedByPrompt',
    facetKind: null,
    facetKey: null,
    facetValue: null,
    filterKey: 'prompt:prompt-1',
    listModeKey: 'llm',
    promptId: 'prompt-1',
    staleReason: null,
    summaryIdentity: 'review.llm.assessedByPrompt',
    summaryKind: 'count',
    ...input,
  }
}

const sourceFacetRow = (input?: Record<string, unknown>) => {
  return {
    answerId: null,
    answerValue: 'yes',
    articleId: 'article-1',
    availability: 'ready',
    countKind: 'review.human.filter.summaryAnswer',
    facetKind: 'human',
    facetKey: 'summaryAnswer',
    facetValue: 'yes',
    filterKey: null,
    listModeKey: null,
    promptId: 'summary',
    staleReason: null,
    summaryIdentity: 'review.human.filter.summaryAnswer',
    summaryKind: 'facet',
    ...input,
  }
}

const storedContributionRow = (sourceRow: Record<string, unknown>) => {
  const {articleId: _articleId, ...identity} = sourceRow

  return {
    articleId: sourceRow.articleId,
    contributionKey: contributionKey(identity),
    contributionValue: 1,
    summaryDefinitionVersion: 'review-serving-summary:v1',
  }
}

const createSummaryDatabase = (input?: {
  contributionRows?: readonly Record<string, unknown>[]
  countRows?: readonly Record<string, unknown>[]
  facetRows?: readonly Record<string, unknown>[]
  sourceRows?: readonly Record<string, unknown>[]
}) => {
  const statements: string[] = []
  const database: ReviewServingSummaryProjectorDatabase = {
    queryJson: async <T>(statement: string) => {
      statements.push(statement)

      if (statement.includes('FROM summary_union')) {
        return (input?.sourceRows ?? []) as T[]
      }

      if (statement.includes('mart.review_article_summary_contribution_v4')) {
        return (input?.contributionRows ?? []) as T[]
      }

      if (statement.includes('FROM mart.review_article_count_serving_v4')) {
        return (input?.countRows ?? []) as T[]
      }

      if (statement.includes('FROM mart.review_filter_facet_serving_v4')) {
        return (input?.facetRows ?? []) as T[]
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

const hasSummaryValue = (rows: readonly Record<string, unknown>[], expected: Record<string, unknown>) => {
  return rows.some((row) => {
    return Object.entries(expected).every(([key, value]) => {
      return row[key] === value
    })
  })
}

test('projects list-mode count deltas with summary identity and definition version', async () => {
  const oldRow = sourceCountRow({listModeKey: 'human'})
  const newRow = sourceCountRow({listModeKey: 'llm'})
  const {database, statements} = createSummaryDatabase({
    contributionRows: [storedContributionRow(oldRow)],
    countRows: [
      {countKind: 'review.llm.assessedByPrompt', countValue: 3, filterKey: 'prompt:prompt-1', listModeKey: 'human'},
      {countKind: 'review.llm.assessedByPrompt', countValue: 7, filterKey: 'prompt:prompt-1', listModeKey: 'llm'},
    ],
    sourceRows: [newRow],
  })

  const result = await projectReviewServingSummaries(projectInput([summaryClaim()], ['llm', 'human']), database)
  const joined = statements.join('\n')

  expect(
    hasSummaryValue(result.summaryValues, {
      count_kind: 'review.llm.assessedByPrompt',
      count_value: 2,
      filter_key: 'prompt:prompt-1',
      list_mode_key: 'human',
      summary_definition_version: 'review-llm-assessed-by-prompt:v1',
      summary_identity: 'review.llm.assessedByPrompt',
    }),
  ).toBe(true)
  expect(hasSummaryValue(result.summaryValues, {count_value: 8, list_mode_key: 'llm'})).toBe(true)
  expect(joined).toContain('selected_base.project_scope_identity')
  expect(joined).toContain('selected_base.selected_import_snapshot_id')
  expect(joined).toContain('COALESCE(selected_patch.tombstone, selected_base.tombstone, FALSE)')
  expect(joined).toContain('COALESCE(selected_patch.duplicate_flag, selected_base.duplicate_flag, FALSE)')
  expect(joined).toContain('llm.base_generation = 5')
  expect(joined).toContain('scoped.in_scope AS in_selected_scope')
  expect(joined).toContain('FROM mart.review_selected_import_patch_v4 newer')
  expect(joined).toContain('INSERT INTO mart.review_article_count_serving_v4')
  expect(joined).toContain('INSERT INTO mart.review_article_summary_contribution_v4')
})

test('projects human summary-answer facets independently from prompt answers', async () => {
  const {database, statements} = createSummaryDatabase({
    facetRows: [
      {
        countValue: 4,
        facetKey: 'summaryAnswer',
        facetValue: 'yes',
        summaryIdentity: 'review.human.filter.summaryAnswer',
      },
    ],
    sourceRows: [sourceFacetRow()],
  })

  const result = await projectReviewServingSummaries(
    projectInput([summaryClaim({dirtyKind: 'judgment.human.updated'})]),
    database,
  )
  const selectStatement = statements.find((statement) => {
    return statement.includes('FROM summary_union')
  })

  expect(
    hasSummaryValue(result.summaryValues, {
      answer_value: 'yes',
      count_value: 5,
      facet_key: 'summaryAnswer',
      facet_kind: 'human',
      facet_value: 'yes',
      prompt_id: 'summary',
      summary_definition_version: 'review-human-filter-summary-answer:v1',
      summary_identity: 'review.human.filter.summaryAnswer',
    }),
  ).toBe(true)
  expect(selectStatement).toContain('FROM mart.review_human_status_patch_v4 newer')
  expect(selectStatement).toContain('human.base_generation = 5')
  expect(selectStatement).toContain('newer.prompt_id IS NOT DISTINCT FROM human.prompt_id')
})

test('projects llm prompt-answer facets from array answers', async () => {
  const {database, statements} = createSummaryDatabase({sourceRows: []})

  await projectReviewServingSummaries(projectInput([summaryClaim()]), database)
  const selectStatement = statements.find((statement) => {
    return statement.includes('FROM summary_union')
  })

  expect(selectStatement).toContain('CROSS JOIN UNNEST(llm.answered_original_as_array) AS answer(answer_value)')
  expect(selectStatement).toContain('answer.answer_value AS facetValue')
  expect(selectStatement).toContain('llm.answered_original_as_array IS NOT NULL')
})

test('date range and search-scope SQL stays scoped and explicit unsupported filtered counts are unavailable', async () => {
  const unavailableRow = sourceCountRow({
    availability: 'unavailable',
    countKind: 'review.list.filteredTotal',
    filterKey: 'filter:dynamic',
    listModeKey: 'llm',
    promptId: null,
    staleReason: 'dynamic filter/search scopes require a precomputed filter signature',
    summaryIdentity: 'review.list.filteredTotal',
  })
  const {database, statements} = createSummaryDatabase({sourceRows: [unavailableRow]})

  const result = await projectReviewServingSummaries(
    projectInput([summaryClaim({dirtyKind: 'projectScope.article.added'})]),
    database,
  )
  const sourceStatement = statements.find((statement) => {
    return statement.includes('FROM summary_union')
  })

  expect(sourceStatement).toContain('selected_base.publication_year')
  expect(sourceStatement).toContain('selected_patch.publication_year')
  expect(sourceStatement).not.toContain('scope.publication_year')
  expect(sourceStatement).toContain('filter:dynamic')
  expect(
    hasSummaryValue(result.summaryValues, {
      availability: 'unavailable',
      count_kind: 'review.list.filteredTotal',
      count_value: null,
      filter_key: 'filter:dynamic',
      stale_reason: 'dynamic filter/search scopes require a precomputed filter signature',
    }),
  ).toBe(true)
})

test('summary diffs aggregate before writing shared count keys', async () => {
  const {database} = createSummaryDatabase({
    countRows: [
      {countKind: 'review.queue.unassessedReady', countValue: 4, filterKey: 'queue:ready', listModeKey: 'llm'},
    ],
    sourceRows: [
      sourceCountRow({
        countKind: 'review.queue.unassessedReady',
        filterKey: 'queue:ready',
        promptId: 'prompt-1',
        summaryIdentity: 'review.queue.unassessedReady',
      }),
      sourceCountRow({
        countKind: 'review.queue.unassessedReady',
        filterKey: 'queue:ready',
        promptId: 'prompt-2',
        summaryIdentity: 'review.queue.unassessedReady',
      }),
    ],
  })

  const result = await projectReviewServingSummaries(projectInput([summaryClaim()]), database)

  expect(
    result.summaryValues.filter((row) => {
      return row.count_kind === 'review.queue.unassessedReady'
    }),
  ).toHaveLength(1)
  expect(hasSummaryValue(result.summaryValues, {count_kind: 'review.queue.unassessedReady', count_value: 6})).toBe(true)
})

test('summary status and answer sources require selected scope', async () => {
  const {database, statements} = createSummaryDatabase()

  await projectReviewServingSummaries(projectInput([summaryClaim()]), database)

  const sourceStatement = statements.find((statement) => {
    return statement.includes('FROM summary_union')
  })

  expect(sourceStatement).toContain('selected.article_id = llm.article_id AND selected.in_selected_scope')
  expect(sourceStatement).toContain('selected.article_id = queue.article_id AND selected.in_selected_scope')
  expect(sourceStatement).toContain('selected.article_id = human.article_id AND selected.in_selected_scope')
})

test('unsupported or incompatible contribution state enqueues repair instead of scanning raw tables', async () => {
  const {database, statements} = createSummaryDatabase({
    contributionRows: [{...storedContributionRow(sourceCountRow()), summaryDefinitionVersion: 'old-summary:v0'}],
    sourceRows: [sourceCountRow()],
  })

  const result = await projectReviewServingSummaries(projectInput([summaryClaim()]), database)
  const joined = statements.join('\n')

  expect(result.repairRequired).toBe(true)
  expect(result.summaryRowCount).toBe(0)
  expect(joined).toContain('INSERT INTO app.review_serving_dirty_work')
  expect(joined).not.toContain('INSERT INTO mart.review_article_count_serving_v4')
})
