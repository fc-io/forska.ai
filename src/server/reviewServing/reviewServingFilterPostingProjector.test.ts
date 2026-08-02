import {expect, test} from 'bun:test'

import {type ReviewServingDirtyWorkClaim} from './reviewServingDirtyWorkService.ts'
import {
  projectReviewServingFilterPostingRanges,
  projectReviewServingFilterPostings,
  type ReviewServingFilterPostingProjectorDatabase,
} from './reviewServingFilterPostingProjector.ts'

const postingRow = (input?: Record<string, unknown>) => {
  return {
    articleId: 'article-1',
    filterKind: 'promptAnswer',
    filterValue: 'review:promptAnswer:prompt-1:yes',
    listModeKey: 'llm',
    tombstone: false,
    ...input,
  }
}

const contributionKey = (row: Record<string, unknown>) => {
  return JSON.stringify({filterKind: row.filterKind, filterValue: row.filterValue, listModeKey: row.listModeKey})
}

const servingRowKey = (row: Record<string, unknown>) => {
  return JSON.stringify({
    articleId: row.articleId,
    filterKind: row.filterKind,
    filterValue: row.filterValue,
    listModeKey: row.listModeKey,
  })
}

const liveServingRowCount = (rows: readonly Record<string, unknown>[]) => {
  return new Set(
    rows
      .filter((row) => {
        return row.tombstone !== true
      })
      .map((row) => {
        return servingRowKey(row)
      }),
  ).size
}

const legacyPostingSourcePatchTables = [
  'mart.review_selected_import_patch_v4',
  'mart.review_llm_status_patch_v4',
  'mart.review_human_status_patch_v4',
]

const expectNoLegacyPostingSourcePatchTables = (statement: string) => {
  for (const table of legacyPostingSourcePatchTables) {
    expect(statement).not.toContain(table)
  }
}

const countOccurrences = (value: string, search: string) => {
  return value.split(search).length - 1
}

const createPostingDatabase = (input?: {
  contributionTotalRows?: readonly Record<string, unknown>[]
  contributionRows?: readonly Record<string, unknown>[]
  existingRows?: readonly Record<string, unknown>[]
  newRows?: readonly Record<string, unknown>[]
  totalRows?: readonly Record<string, unknown>[]
}) => {
  const statements: string[] = []
  const database: ReviewServingFilterPostingProjectorDatabase = {
    queryJson: async <T>(statement: string) => {
      statements.push(statement)

      if (statement.includes('FROM app.review_source_change_outbox')) {
        return [] as T[]
      }

      if (statement.includes('FROM posting_union')) {
        return (input?.newRows ?? []) as T[]
      }

      if (
        statement.includes("sha256('cheap-count:'")
        && statement.includes('FROM mart.review_article_filter_posting_serving_v4 serving')
      ) {
        const actualCount = liveServingRowCount(input?.newRows ?? [])

        return [{actualChecksum: `cheap-count:${actualCount}`, actualCount}] as T[]
      }

      if (statement.includes('FROM mart.review_article_filter_posting_serving_v4 serving')) {
        return (input?.existingRows ?? []) as T[]
      }

      if (statement.includes('SUM(contribution.contribution_value)')) {
        return (input?.contributionTotalRows ?? []) as T[]
      }

      if (statement.includes('AS totalArticleCount')) {
        return (input?.totalRows ?? [{listModeKey: 'llm', totalArticleCount: 10}]) as T[]
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

const postingClaim = (input?: Partial<ReviewServingDirtyWorkClaim>): ReviewServingDirtyWorkClaim => {
  return {
    articleId: 'article-1',
    dirtyKind: 'judgment.llm.updated',
    dirtyRangeEnd: null,
    dirtyRangeStart: null,
    dirtyWorkId: 'dirty-work-1',
    firstSourceHighWaterMark: 12,
    latestDeltaId: 'delta-1',
    latestSourceHighWaterMark: 14,
    projectId: 'project-1',
    projectionComponent: 'posting',
    projectionIdentity: 'posting:identity-1',
    scopeId: 'project-1:article-1',
    scopeKind: 'article',
    sourcePartition: 'llmJudgment:article-1',
    status: 'running',
    ...input,
  }
}

const projectInput = (claims: readonly ReviewServingDirtyWorkClaim[], listModeKeys: readonly string[] = ['llm']) => {
  return {
    baseGeneration: 5,
    claims,
    definitionVersion: 'posting-v4-test',
    listModeKeys,
    projectId: 'project-1',
    projectScopeIdentity: 'project-scope-1',
    projectionIdentity: 'posting:identity-1',
    reviewConfigHash: 'review-config-1',
    selectedImportSnapshotId: 'selected-snapshot-1',
    snapshotId: 'snapshot-1',
  }
}

test('answer changes invalidate lazy prompt-answer postings without derived stats writes', async () => {
  const {database, statements} = createPostingDatabase({
    existingRows: [postingRow({filterValue: 'review:promptAnswer:prompt-1:no'})],
    newRows: [postingRow({filterValue: 'review:promptAnswer:prompt-1:yes'})],
  })

  const result = await projectReviewServingFilterPostings(projectInput([postingClaim()]), database)
  const joined = statements.join('\n')

  expect(result.patchRowCount).toBe(0)
  expect(result.servingRowCount).toBe(0)
  expect(result.validationResult).toBeUndefined()
  expect(result.diagnosticsJson.phaseTimings.sourceQueryMs).toBeGreaterThanOrEqual(0)
  expect(result.diagnosticsJson.phaseTimings.writerMs).toBeGreaterThanOrEqual(0)
  expect(result.diagnosticsJson.postingProjector.writer.records.inputRecordsByTable).not.toHaveProperty(
    'mart.review_article_filter_posting_serving_v4',
  )
  expect(joined).not.toContain('scope.source_updated_at')
  expect(joined).not.toContain('sort_key')
  expect(joined).not.toContain('mart.review_article_filter_posting_patch_v4')
  expect(joined).not.toContain('mart.review_filter_posting_stats_v4')
  expect(joined).toContain('UPDATE mart.review_article_filter_posting_serving_v4 serving')
  expect(joined).toContain('list_filter(article_ids')
  expect(joined).not.toContain('INSERT INTO mart.review_article_filter_posting_serving_v4')
})

test('posting no-ack snapshot passes do not publish shared manifests or watermarks', async () => {
  const {database, statements} = createPostingDatabase({newRows: [postingRow()]})

  await projectReviewServingFilterPostings({...projectInput([postingClaim()]), acknowledgeClaims: false}, database)
  const joined = statements.join('\n')

  expect(joined).not.toContain('INSERT INTO app.review_projection_identity_manifest')
  expect(joined).not.toContain('INSERT INTO app.review_serving_projector_watermark')
  expect(joined).not.toContain('INSERT INTO app.review_serving_dirty_work_ack')
})

test('full posting rebuilds write serving state without derived stats refresh', async () => {
  const row = postingRow({filterKind: 'conflictFlag', filterValue: 'false', listModeKey: 'both'})
  const {database, statements} = createPostingDatabase({
    contributionTotalRows: [{contributionKey: contributionKey(row), contributionValue: '2'}],
    existingRows: [],
    newRows: [row],
    totalRows: [{listModeKey: 'both', totalArticleCount: '10'}],
  })

  await projectReviewServingFilterPostings(projectInput([], ['both']), database)
  const joined = statements.join('\n')

  expect(joined).not.toContain('mart.review_filter_posting_stats_v4')
  expect(joined).not.toContain('COUNT(*) AS cardinality')
  expect(joined).toContain('FROM mart.review_article_filter_posting_serving_v4 serving')
  expect(joined).toContain('UPDATE mart.review_article_filter_posting_serving_v4 serving')
  expect(joined).toContain('WHERE NOT EXISTS')
  expect(joined).not.toContain('ON CONFLICT')
  expectNoLegacyPostingSourcePatchTables(joined)
  expect(joined).not.toContain('SUM(contribution.contribution_value)')
  expect(joined).not.toContain('343341342341341300000')
})

test('full posting rebuilds write serving without contribution or incremental patch fanout', async () => {
  const {database, statements} = createPostingDatabase({
    existingRows: [],
    newRows: [
      postingRow({filterKind: 'importRoute', filterValue: 'route-1'}),
      postingRow({filterKind: 'importRoute', filterValue: 'route-1'}),
    ],
  })

  const result = await projectReviewServingFilterPostings(projectInput([]), database)
  const joined = statements.join('\n')

  expect(result.patchRowCount).toBe(0)
  expect(result.servingRowCount).toBe(1)
  expect(result.diagnosticsJson.postingProjector).toMatchObject({fullRebuildMode: 'set-based'})
  expect(result.validationResult).toMatchObject({
    actualCount: 1,
    diagnosticsJson: {validationMode: 'post-write-serving-count'},
    expectedCount: 1,
  })
  expect(result.validationResult?.actualChecksum).toBe(result.validationResult?.expectedChecksum)
  expect(result.diagnosticsJson.postingProjector.writer.records.inputRecordsByTable).not.toHaveProperty(
    'mart.review_article_filter_posting_patch_v4',
  )
  expect(result.diagnosticsJson.postingProjector.writer.records.inputRecordsByTable).not.toHaveProperty(
    'mart.review_article_filter_posting_serving_v4',
  )
  expect(result.diagnosticsJson.postingProjector.writer.records.inputRecordsByTable).not.toHaveProperty(
    'mart.review_article_summary_contribution_v4',
  )
  expect(joined).not.toContain('INSERT INTO mart.review_article_filter_posting_patch_v4')
  expect(joined).toContain('UPDATE mart.review_article_filter_posting_serving_v4 serving')
  expect(joined).toContain('INSERT INTO mart.review_article_filter_posting_serving_v4')
  expect(joined).toContain('WHERE NOT EXISTS')
  expect(joined).not.toContain('ON CONFLICT')
  expect(joined).toContain('article_ids = (SELECT LIST(DISTINCT article_id ORDER BY article_id)')
  expect(joined).toContain(
    'LIST(DISTINCT CAST(posting.articleId AS VARCHAR) ORDER BY CAST(posting.articleId AS VARCHAR)) AS articleIds',
  )
  expect(joined).not.toContain('posting_identity,')
  expect(joined).not.toContain('AS posting_identity')
  expect(joined).not.toContain('posting_updated_at = excluded.posting_updated_at')
  expect(joined).not.toContain('DELETE FROM mart.review_article_summary_contribution_v4 contribution')
  expect(joined).not.toContain('INSERT INTO mart.review_article_summary_contribution_v4')
  expect(joined).toContain('WITH posting_source AS')
  expect(joined).toContain('serving_source AS')
  expect(joined).toContain('GROUP BY\n        CAST(posting.filterKind AS VARCHAR)')
  expect(joined).toContain('CAST(posting.filterValue AS VARCHAR) AS filterValue')
  expect(joined).toContain('CAST(posting.listModeKey AS VARCHAR) AS listModeKey')
  expect(joined).toContain('LEFT JOIN mart.review_selected_article_import_current_v4 selected')
  expect(joined).toContain('INNER JOIN mart.review_article_serving_base_v4 serving')
  expect(joined).toContain('INNER JOIN mart.review_article_serving_list_mode_state_v4 list_mode_state')
  expect(joined).toContain('INNER JOIN list_mode_key_filter list_mode_key_filter ON TRUE')
  expect(joined).toContain("('llm', list_mode_state.has_llm_list_mode)")
  expect(joined).toContain("('human', list_mode_state.has_human_list_mode)")
  expect(joined).toContain("('both', list_mode_state.has_both_list_mode)")
  expect(joined).toContain("('unassessed', list_mode_state.has_unassessed_list_mode)")
  expect(joined).toContain('list_mode_key_filter.list_mode_key = list_mode_key.list_mode_key')
  expect(joined).toContain('list_mode_key.has_list_mode IS TRUE')
  expect(joined).not.toContain('list_contains(list_mode_state.list_mode_keys')
  expect(joined).not.toContain('INNER JOIN mart.review_article_serving_v4 serving')
  expect(countOccurrences(joined, 'mart.review_article_judgment_detail_serving_v4 detail')).toBe(1)
  expect(joined).toContain('judgment_detail_source AS')
  expect(joined).toContain('article_judgment_status AS')
  expect(joined).toContain(
    "WHEN enabled_prompt_count.prompt_count = article_judgment_status.llm_answered_prompt_count THEN 'answered'",
  )
  expect(joined).not.toContain('llm_enabled_prompt_count')
  expect(joined).not.toContain('serving.llm_status_key')
  expect(joined).not.toContain('serving.human_status_key')
  expect(joined).toContain("concat('review:promptAnswer:', llm.prompt_id, ':', llm.answered_original)")
  expect(joined).toContain("concat('review:promptAnswer:summary:', summary.summary_answer)")
  expect(joined).toContain("concat('human:promptAnswer:', human.prompt_id, ':', human.answered_original)")
  expectNoLegacyPostingSourcePatchTables(joined)
})

test('full posting rebuilds skip lazy prompt-answer buckets', async () => {
  const {database, statements} = createPostingDatabase({
    newRows: [postingRow({filterKind: 'importRoute', filterValue: 'route-1'})],
  })

  await projectReviewServingFilterPostings(projectInput([], ['llm', 'human', 'both']), database)
  const sourceStatement = statements.find((statement) => {
    return statement.includes('FROM posting_union')
  })

  expect(sourceStatement).toContain('SELECT * FROM selected_postings')
  expect(sourceStatement).toContain('UNION ALL SELECT * FROM serving_status_postings')
  expect(sourceStatement).not.toContain('UNION ALL SELECT * FROM llm_postings')
  expect(sourceStatement).not.toContain('UNION ALL SELECT * FROM llm_summary_postings')
  expect(sourceStatement).not.toContain('UNION ALL SELECT * FROM human_postings')
})

test('full posting rebuilds delete stale lazy prompt-answer cache rows', async () => {
  const {database, statements} = createPostingDatabase({
    newRows: [postingRow({filterKind: 'importRoute', filterValue: 'route-1'})],
  })

  await projectReviewServingFilterPostings(projectInput([], ['llm', 'human', 'both']), database)
  const joined = statements.join('\n')

  expect(joined).toContain('DELETE FROM mart.review_article_filter_posting_serving_v4')
  expect(joined).toContain("AND filter_kind = 'promptAnswer'")
})

test('full posting rebuilds scope set-based serving upserts to article ranges', async () => {
  const {database, statements} = createPostingDatabase({
    existingRows: [],
    newRows: [postingRow({articleId: 'article-2', filterKind: 'importRoute', filterValue: 'route-1'})],
  })

  await projectReviewServingFilterPostings(
    {...projectInput([]), chunkEndArticleId: 'article-9', chunkStartArticleId: 'article-2'},
    database,
  )

  const joined = statements.join('\n')

  expect(joined).toContain("AND filter_kind = 'promptAnswer'")
  expect(joined).not.toContain('DELETE FROM mart.review_article_filter_posting_serving_v4 serving')
  expect(joined).toContain('scope.article_id >=')
  expect(joined).toContain('scope.article_id <=')
  expect(joined).toContain('UPDATE mart.review_article_filter_posting_serving_v4 serving')
  expect(joined).toContain('WHERE NOT EXISTS')
  expect(joined).not.toContain('ON CONFLICT')
  expect(joined).not.toContain('posting_identity,')
  expect(joined).not.toContain('AS posting_identity')
  expect(joined).not.toContain('sort_key = excluded.sort_key')
  expect(joined).not.toContain('DELETE FROM mart.review_article_summary_contribution_v4 contribution')
})

test('chunked full posting rebuilds skip retired stats refresh', async () => {
  const {database, statements} = createPostingDatabase({
    existingRows: [],
    newRows: [postingRow({articleId: 'article-2', filterKind: 'importRoute', filterValue: 'route-1'})],
  })

  await projectReviewServingFilterPostings(
    {...projectInput([]), chunkEndArticleId: 'article-9', chunkStartArticleId: 'article-2'},
    database,
  )

  const joined = statements.join('\n')

  expect(joined).not.toContain('DELETE FROM mart.review_article_filter_posting_serving_v4 serving')
  expect(joined).toContain('INSERT INTO mart.review_article_filter_posting_serving_v4')
  expect(joined).toContain('UPDATE mart.review_article_filter_posting_serving_v4 serving')
  expect(joined).toContain('WHERE NOT EXISTS')
  expect(joined).not.toContain('ON CONFLICT')
  expect(joined).not.toContain('posting_identity')
  expect(joined).not.toContain('DELETE FROM mart.review_filter_posting_stats_v4 stats')
  expect(joined).not.toContain('INSERT INTO mart.review_filter_posting_stats_v4')
})

test('posting range rebuilds append segmented serving rows without merging existing posting arrays', async () => {
  const {database, statements} = createPostingDatabase()

  const result = await projectReviewServingFilterPostingRanges(
    {
      ranges: [
        {...projectInput([]), chunkEndArticleId: 'article-3', chunkStartArticleId: 'article-1'},
        {...projectInput([]), chunkEndArticleId: 'article-9', chunkStartArticleId: 'article-4'},
      ],
    },
    database,
  )

  const servingInserts = statements.filter((statement) => {
    return statement.includes('INSERT INTO mart.review_article_filter_posting_serving_v4')
  })
  const joined = statements.join('\n')

  expect(result.diagnosticsJson.postingProjector).toMatchObject({fullRebuildMode: 'range-set-based', rangeCount: 2})
  expect(servingInserts).toHaveLength(1)
  expect(joined).toContain('article_range_filter(chunk_start_article_id, chunk_end_article_id)')
  expect(joined).toContain("('article-1', 'article-3'), ('article-4', 'article-9')")
  expect(joined).toContain('UPDATE mart.review_article_filter_posting_serving_v4 serving')
  expect(joined).toContain('SET article_ids = list_filter')
  expect(joined).not.toContain('article_ids = (SELECT LIST(DISTINCT article_id ORDER BY article_id)')
  expect(joined).toContain('SELECT DISTINCT scope.article_id')
  expect(countOccurrences(joined, 'mart.review_article_judgment_detail_serving_v4 detail')).toBe(1)
  expect(joined).toContain('judgment_detail_source AS')
  expect(joined).toContain('article_judgment_status AS')
  expect(joined).toContain('range.chunk_start_article_id IS NULL OR scope.article_id >= range.chunk_start_article_id')
  expect(joined).toContain('range.chunk_end_article_id IS NULL OR scope.article_id <= range.chunk_end_article_id')
  expect(servingInserts[0]).not.toContain('posting_identity')
  expect(servingInserts[0]).not.toContain('WHERE NOT EXISTS')
  expect(joined).not.toContain('DELETE FROM mart.review_filter_posting_stats_v4 stats')
  expect(joined).not.toContain('INSERT INTO mart.review_filter_posting_stats_v4')
  expect(joined).not.toContain('WHERE NOT EXISTS')
  expectNoLegacyPostingSourcePatchTables(joined)
})

test('deletes write tombstones and remove serving rows without derived stats writes', async () => {
  const {database, statements} = createPostingDatabase({
    existingRows: [postingRow({filterKind: 'llmStatus', filterValue: 'answered'})],
    newRows: [],
  })

  const result = await projectReviewServingFilterPostings(
    projectInput([postingClaim({dirtyKind: 'judgment.llm.deleted'})]),
    database,
  )
  const joined = statements.join('\n')

  expect(result.patchRowCount).toBe(0)
  expect(result.servingRowCount).toBe(0)
  expect(joined).toContain('UPDATE mart.review_article_filter_posting_serving_v4 serving')
  expect(joined).toContain('SET article_ids = list_filter')
  expect(joined).not.toContain('DELETE FROM mart.review_article_filter_posting_serving_v4')
  expect(joined).not.toContain('INSERT INTO mart.review_article_filter_posting_patch_v4')
  expect(joined).not.toContain('mart.review_filter_posting_stats_v4')
  expect(joined).toContain('INSERT INTO app.review_serving_dirty_work_ack')
  expect(joined).toContain('INSERT INTO app.review_serving_projector_watermark')
  expect(joined).toContain('WHERE NOT EXISTS')
})

test('membership removals scope through project_scope_article and tombstone existing postings', async () => {
  const {database, statements} = createPostingDatabase({
    existingRows: [postingRow({filterKind: 'importRoute', filterValue: 'route-1'})],
    newRows: [],
  })

  await projectReviewServingFilterPostings(
    projectInput([postingClaim({dirtyKind: 'projectScope.article.removed'})]),
    database,
  )
  const joined = statements.join('\n')

  expect(joined).toContain('INNER JOIN mart.project_scope_article scope')
  expect(joined).toContain('scope_tombstone')
  expect(joined).toContain("'posting'")
  expect(joined).not.toContain('selected_scoped_article_import')
})

test('selected-import rank changes move filter contribution between selected import values', async () => {
  const {database, statements} = createPostingDatabase({
    existingRows: [postingRow({filterKind: 'importRoute', filterValue: 'route-old'})],
    newRows: [postingRow({filterKind: 'importRoute', filterValue: 'route-new'})],
  })

  await projectReviewServingFilterPostings(
    projectInput([postingClaim({dirtyKind: 'importRoute.article.rankFields.updated'})]),
    database,
  )
  const selectStatement = statements.find((statement) => {
    return statement.includes('FROM posting_union')
  })

  expect(selectStatement).toContain('LEFT JOIN mart.review_selected_article_import_current_v4 selected')
  expect(selectStatement).not.toContain('selected_patch')
  expect(selectStatement).toContain('scoped.scope_tombstone AS tombstone')
  expect(selectStatement).not.toContain('mart.review_selected_import_patch_v4')
})

test('selected-import filter postings prefer hot fields for payload filters while keeping selected-base identity', async () => {
  const {database, statements} = createPostingDatabase({
    newRows: [postingRow({filterKind: 'publicationYear', filterValue: '2026'})],
  })

  await projectReviewServingFilterPostings(
    projectInput([postingClaim({dirtyKind: 'importRoute.article.hotFields.updated'})]),
    database,
  )
  const selectStatement = statements.find((statement) => {
    return statement.includes('FROM posting_union')
  })

  expect(selectStatement).toContain('LEFT JOIN mart.review_selected_article_import_current_v4 selected')
  expect(selectStatement).toContain('LEFT JOIN app.review_import_article_hot_field selected_hot')
  expect(selectStatement).toContain('selected.import_route_id')
  expect(selectStatement).toContain('selected.selected_rank_key')
  expect(selectStatement).toContain('selected_hot.import_route_id = selected.import_route_id')
  expect(selectStatement).toContain('selected_hot.article_id = selected.article_id')
  expect(selectStatement).toContain('selected_hot.source_record_key = selected.source_record_key')
  expect(selectStatement).toContain('AND NOT selected_hot.tombstone')
  expect(selectStatement).toContain('selected_hot.publication_year AS publication_year')
  expect(selectStatement).not.toContain('COALESCE(selected_hot.publication_year, selected.publication_year)')
  expect(selectStatement).toContain('COALESCE(selected_hot.duplicate_flag, FALSE) AS duplicate_flag')
  expect(selectStatement).toContain('COALESCE(selected_hot.conflict_flag, FALSE) AS conflict_flag')
  expect(selectStatement).not.toContain('COALESCE(selected_hot.duplicate_flag, selected.duplicate_flag')
  expect(selectStatement).not.toContain('COALESCE(selected_hot.conflict_flag, selected.conflict_flag')
  expect(selectStatement).not.toContain('mart.review_selected_import_patch_v4')
  expect(selectStatement).not.toContain('selected_patch')
})

test('human postings read only the current status patch per logical prompt key', async () => {
  const {database, statements} = createPostingDatabase({newRows: []})

  await projectReviewServingFilterPostings(
    projectInput([postingClaim({dirtyKind: 'judgment.human.updated'})]),
    database,
  )
  const selectStatement = statements.find((statement) => {
    return statement.includes('FROM posting_union')
  })

  expect(selectStatement).not.toContain('mart.review_human_status_patch_v4')
  expect(selectStatement).toContain('human_detail AS')
})

test('status postings compare LLM answered rows to project enabled prompt count', async () => {
  const {database, statements} = createPostingDatabase({newRows: []})

  await projectReviewServingFilterPostings(projectInput([postingClaim()], ['llm', 'human']), database)
  const selectStatement = statements.find((statement) => {
    return statement.includes('FROM posting_union')
  })

  expect(selectStatement).toContain('scoped_serving AS')
  expect(selectStatement).toContain('INNER JOIN mart.review_article_serving_base_v4 serving')
  expect(selectStatement).toContain('INNER JOIN mart.review_article_serving_list_mode_state_v4 list_mode_state')
  expect(selectStatement).toContain('INNER JOIN list_mode_key_filter list_mode_key_filter ON TRUE')
  expect(selectStatement).toContain("('llm', list_mode_state.has_llm_list_mode)")
  expect(selectStatement).toContain("('human', list_mode_state.has_human_list_mode)")
  expect(selectStatement).toContain("('both', list_mode_state.has_both_list_mode)")
  expect(selectStatement).toContain("('unassessed', list_mode_state.has_unassessed_list_mode)")
  expect(selectStatement).toContain('list_mode_key_filter.list_mode_key = list_mode_key.list_mode_key')
  expect(selectStatement).toContain('list_mode_key.has_list_mode IS TRUE')
  expect(selectStatement).not.toContain('list_contains(list_mode_state.list_mode_keys')
  expect(selectStatement).not.toContain('INNER JOIN mart.review_article_serving_v4 serving')
  expect(selectStatement).toContain('judgment_detail_source AS')
  expect(selectStatement).toContain('article_judgment_status AS')
  expect(selectStatement).not.toContain('llm_status AS')
  expect(selectStatement).not.toContain('human_status AS')
  expect(countOccurrences(selectStatement, 'mart.review_article_judgment_detail_serving_v4 detail')).toBe(1)
  expect(selectStatement).toContain('COUNT(detail.prompt_id) FILTER')
  expect(selectStatement).toContain('llm_answered_non_placeholder_prompt_count')
  expect(selectStatement).toContain('AND detail.placeholder_kind IS NULL')
  expect(selectStatement).toContain("detail.payload_kind IN ('llm', 'human')")
  expect(selectStatement).not.toContain('detail.list_mode_key')
  expect(selectStatement).toContain("WHERE detail.payload_kind = 'llm'")
  expect(selectStatement).toContain("WHERE detail.payload_kind = 'human'")
  expect(selectStatement).toContain("'llmStatus' AS filterKind")
  expect(selectStatement).toContain("'llmHasJudgment' AS filterKind")
  expect(selectStatement).toContain(
    'CAST(article_judgment_status.llm_answered_non_placeholder_prompt_count > 0 AS VARCHAR) AS filterValue',
  )
  expect(selectStatement).toContain("'humanStatus' AS filterKind")
  expect(selectStatement).toContain('enabled_prompt_count AS')
  expect(selectStatement).toContain('FROM app.project_prompt project_prompt')
  expect(selectStatement).toContain('INNER JOIN app.prompt prompt')
  expect(selectStatement).toContain('WHEN enabled_prompt_count.prompt_count = 0 THEN NULL')
  expect(selectStatement).toContain(
    "WHEN enabled_prompt_count.prompt_count = article_judgment_status.llm_answered_prompt_count THEN 'answered'",
  )
  expect(selectStatement).not.toContain('llm_enabled_prompt_count')
  expect(selectStatement).toContain(
    "WHEN enabled_prompt_count.prompt_count = article_judgment_status.human_answered_prompt_count THEN 'answered'",
  )
  expect(selectStatement).not.toContain('serving.llm_status_key')
  expect(selectStatement).not.toContain('serving.human_status_key')
  expect(selectStatement).toContain('project_settings AS')
  expect(selectStatement).toContain("human_judgment_mode = 'summary'")
  expect(selectStatement).toContain('human_detail AS')
})

test('embedded filter state patches aggregate state rows per article', async () => {
  const {database, statements} = createPostingDatabase({
    newRows: [
      postingRow({filterKind: 'duplicateFlag', filterValue: 'false', listModeKey: 'llm'}),
      postingRow({filterKind: 'duplicateFlag', filterValue: 'true', listModeKey: 'human'}),
      postingRow({filterKind: 'conflictFlag', filterValue: 'true', listModeKey: 'both'}),
      postingRow({filterKind: 'llmStatus', filterValue: 'answered', listModeKey: 'llm'}),
      postingRow({filterKind: 'llmStatus', filterValue: 'unanswered', listModeKey: 'both'}),
      postingRow({filterKind: 'humanStatus', filterValue: 'answered', listModeKey: 'human'}),
    ],
  })

  const result = await projectReviewServingFilterPostings(
    projectInput([postingClaim()], ['llm', 'human', 'both']),
    database,
  )
  const updateStatement = statements.find((statement) => {
    return (
      statement.includes('UPDATE mart.review_article_serving_list_mode_state_v4 state')
      && statement.includes('FROM (VALUES')
    )
  })
  const joined = statements.join('\n')

  expect(result.servingRowCount).toBe(1)
  expect(updateStatement).toContain("('article-1', TRUE, TRUE, 'unanswered', 'answered', FALSE)")
  expect(joined).not.toContain('FROM mart.review_article_filter_state_serving_v4')
  expect(joined).not.toContain('SELECT\n          state.article_id AS articleId')
})

test('embedded filter state patches keep partial LLM judgment presence independent from status', async () => {
  const {database, statements} = createPostingDatabase({
    newRows: [
      postingRow({filterKind: 'llmStatus', filterValue: 'unanswered', listModeKey: 'llm'}),
      postingRow({filterKind: 'llmHasJudgment', filterValue: 'true', listModeKey: 'llm'}),
    ],
  })

  await projectReviewServingFilterPostings(projectInput([postingClaim()], ['llm']), database)
  const updateStatement = statements.find((statement) => {
    return (
      statement.includes('UPDATE mart.review_article_serving_list_mode_state_v4 state')
      && statement.includes('FROM (VALUES')
    )
  })
  const insertStatement = statements.find((statement) => {
    return statement.includes('INSERT INTO mart.review_article_filter_posting_serving_v4')
  })

  expect(updateStatement).toContain("('article-1', FALSE, FALSE, 'unanswered', NULL, TRUE)")
  expect(insertStatement).toBeUndefined()
})

test('human status postings honor summary-mode status rows separately from prompt rows', async () => {
  const {database, statements} = createPostingDatabase({newRows: []})

  await projectReviewServingFilterPostings(
    projectInput([postingClaim({dirtyKind: 'judgment.human.updated'})]),
    database,
  )
  const selectStatement = statements.find((statement) => {
    return statement.includes('FROM posting_union')
  })

  expect(selectStatement).toContain('CROSS JOIN project_settings')
  expect(selectStatement).toContain("human.prompt_id = 'summary'")
  expect(selectStatement).toContain("human.prompt_id <> 'summary'")
  expect(selectStatement).toContain('human_detail AS')
})

test('prompt-answer postings encode prompt ids in filter values', async () => {
  const {database, statements} = createPostingDatabase({newRows: []})

  await projectReviewServingFilterPostings(projectInput([postingClaim()]), database)
  const selectStatement = statements.find((statement) => {
    return statement.includes('FROM posting_union')
  })

  expect(selectStatement).toContain("concat('review:promptAnswer:', llm.prompt_id, ':', llm.answered_original)")
  expect(selectStatement).toContain("concat('review:promptAnswer:', llm.prompt_id, ':', answer.answer_value)")
  expect(selectStatement).toContain("concat('human:promptAnswer:', human.prompt_id, ':', human.answered_original)")
  expect(selectStatement).toContain('llm.answered_original IS NOT NULL')
  expect(selectStatement).toContain('llm.answered_original_as_array IS NULL')
  expect(selectStatement).toContain('answer.answer_value IS NOT NULL')
  expect(selectStatement).toContain('human.answered_original IS NOT NULL')
})

test('prompt-scoped posting rebuilds clear only changed tombstoned serving rows before reinserting', async () => {
  const {database, statements} = createPostingDatabase({existingRows: [postingRow()], newRows: []})

  await projectReviewServingFilterPostings(
    projectInput([
      postingClaim({
        articleId: null,
        dirtyKind: 'prompt.config.updated',
        scopeId: 'project-1:prompt-1',
        scopeKind: 'prompt',
      }),
    ]),
    database,
  )
  const deleteStatement = statements.find((statement) => {
    return (
      statement.includes('UPDATE mart.review_article_filter_posting_serving_v4 serving')
      && statement.includes('USING deleted')
    )
  })
  const existingSelect = statements.find((statement) => {
    return statement.includes('FROM mart.review_article_filter_posting_serving_v4 serving')
  })

  expect(existingSelect).not.toContain('article_id IN')
  expect(deleteStatement).toContain('USING deleted')
  expect(deleteStatement).toContain('filter_kind = deleted.filter_kind')
  expect(deleteStatement).toContain('snapshot_id')
  expect(deleteStatement).not.toContain('article_id IN')
  expect(deleteStatement).not.toContain('DELETE FROM mart.review_article_filter_posting_serving_v4')
})

test('project-scoped posting rebuilds delete tombstoned serving rows without prompt ids', async () => {
  const {database, statements} = createPostingDatabase({existingRows: [postingRow()], newRows: []})

  await projectReviewServingFilterPostings(
    projectInput([
      postingClaim({
        articleId: null,
        dirtyKind: 'project.reviewConfig.updated',
        scopeId: 'project-1',
        scopeKind: 'project',
      }),
    ]),
    database,
  )
  const deleteStatement = statements.find((statement) => {
    return (
      statement.includes('UPDATE mart.review_article_filter_posting_serving_v4 serving')
      && statement.includes('USING deleted')
    )
  })

  expect(deleteStatement).toContain('USING deleted')
  expect(deleteStatement).toContain('filter_kind = deleted.filter_kind')
  expect(deleteStatement).not.toContain('article_id IN')
})

test('list modes keep serving rows scoped without derived stats rows', async () => {
  const {database} = createPostingDatabase({
    existingRows: [],
    newRows: [
      postingRow({filterKind: 'importRoute', filterValue: 'route-1', listModeKey: 'llm'}),
      postingRow({filterKind: 'importRoute', filterValue: 'route-1', listModeKey: 'human'}),
    ],
    totalRows: [
      {listModeKey: 'llm', totalArticleCount: 10},
      {listModeKey: 'human', totalArticleCount: 5},
    ],
  })

  const result = await projectReviewServingFilterPostings(projectInput([postingClaim()], ['llm', 'human']), database)

  expect(result.servingRowCount).toBe(2)
})
