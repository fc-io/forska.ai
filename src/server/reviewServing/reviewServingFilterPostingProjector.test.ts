import {expect, test} from 'bun:test'

import {type ReviewServingDirtyWorkClaim} from './reviewServingDirtyWorkService.ts'
import {
  projectReviewServingFilterPostings,
  type ReviewServingFilterPostingProjectorDatabase,
} from './reviewServingFilterPostingProjector.ts'

const postingRow = (input?: Record<string, unknown>) => {
  return {
    articleId: 'article-1',
    filterKind: 'promptAnswer',
    filterValue: 'review:promptAnswer:prompt-1:yes',
    listModeKey: 'llm',
    sortKey: '2026-06-16T10:00:00.000Z',
    tombstone: false,
    ...input,
  }
}

const contributionKey = (row: Record<string, unknown>) => {
  return JSON.stringify({filterKind: row.filterKind, filterValue: row.filterValue, listModeKey: row.listModeKey})
}

const contributionRow = (row: Record<string, unknown>) => {
  return {
    articleId: row.articleId,
    contributionKey: contributionKey(row),
    contributionValue: 1,
    summaryDefinitionVersion: 'posting-v4-test',
  }
}

const createPostingDatabase = (input?: {
  contributionTotalRows?: readonly Record<string, unknown>[]
  contributionRows?: readonly Record<string, unknown>[]
  existingRows?: readonly Record<string, unknown>[]
  newRows?: readonly Record<string, unknown>[]
  statsRows?: readonly Record<string, unknown>[]
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

      if (statement.includes('FROM mart.review_article_filter_posting_serving_v4 serving')) {
        return (input?.existingRows ?? []) as T[]
      }

      if (
        statement.includes('FROM article_id_filter dirty')
        && statement.includes('review_article_summary_contribution_v4')
      ) {
        return (input?.contributionRows ?? (input?.existingRows ?? []).map(contributionRow)) as T[]
      }

      if (
        statement.includes('SUM(contribution.contribution_value)')
        && statement.includes('GROUP BY filter.contribution_key')
      ) {
        return (input?.contributionTotalRows
          ?? (input?.statsRows ?? []).map((row) => {
            return {contributionKey: contributionKey(row), contributionValue: row.cardinality ?? 0}
          })) as T[]
      }

      if (statement.includes('FROM mart.review_filter_posting_stats_v4')) {
        return (input?.statsRows ?? []) as T[]
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

test('answer changes update posting stats from old and new contribution diffs', async () => {
  const {database, statements} = createPostingDatabase({
    existingRows: [postingRow({filterValue: 'review:promptAnswer:prompt-1:no'})],
    newRows: [postingRow({filterValue: 'review:promptAnswer:prompt-1:yes'})],
    statsRows: [
      {cardinality: 3, filterKind: 'promptAnswer', filterValue: 'review:promptAnswer:prompt-1:no', listModeKey: 'llm'},
      {cardinality: 7, filterKind: 'promptAnswer', filterValue: 'review:promptAnswer:prompt-1:yes', listModeKey: 'llm'},
    ],
  })

  const result = await projectReviewServingFilterPostings(projectInput([postingClaim()]), database)
  const joined = statements.join('\n')

  expect(result.patchRowCount).toBe(2)
  expect(result.servingRowCount).toBe(1)
  expect(result.validationResult).toBeUndefined()
  expect(result.diagnosticsJson.phaseTimings.sourceQueryMs).toBeGreaterThanOrEqual(0)
  expect(result.diagnosticsJson.phaseTimings.writerMs).toBeGreaterThanOrEqual(0)
  expect(result.diagnosticsJson.postingProjector.writer.records.inputRecordsByTable).toMatchObject({
    'mart.review_article_filter_posting_patch_v4': 2,
    'mart.review_article_filter_posting_serving_v4': 1,
  })
  expect(joined).not.toContain('scope.source_updated_at')
  expect(result.statsValues).toContainEqual({
    cardinality: 2,
    filterKind: 'promptAnswer',
    filterValue: 'review:promptAnswer:prompt-1:no',
    listModeKey: 'llm',
    selectivity: 0.2,
  })
  expect(result.statsValues).toContainEqual({
    cardinality: 8,
    filterKind: 'promptAnswer',
    filterValue: 'review:promptAnswer:prompt-1:yes',
    listModeKey: 'llm',
    selectivity: 0.8,
  })
  expect(joined).toContain('INSERT INTO mart.review_article_filter_posting_patch_v4')
  expect(joined).toContain('INSERT INTO mart.review_article_filter_posting_serving_v4')
  expect(joined).toContain('INSERT INTO mart.review_filter_posting_stats_v4')
})

test('posting stats repair corrupted DuckDB BIGINT string cardinalities from contribution state', async () => {
  const row = postingRow({filterKind: 'conflictFlag', filterValue: 'false', listModeKey: 'both'})
  const {database, statements} = createPostingDatabase({
    contributionTotalRows: [{contributionKey: contributionKey(row), contributionValue: '2'}],
    existingRows: [],
    newRows: [row],
    statsRows: [
      {cardinality: '343341342341341300', filterKind: 'conflictFlag', filterValue: 'false', listModeKey: 'both'},
    ],
    totalRows: [{listModeKey: 'both', totalArticleCount: '10'}],
  })

  const result = await projectReviewServingFilterPostings(projectInput([], ['both']), database)
  const joined = statements.join('\n')
  const contributionTotalStatement = statements.find((statement) => {
    return statement.includes('SUM(contribution.contribution_value)')
  })

  expect(result.statsValues).toContainEqual({
    cardinality: 3,
    filterKind: 'conflictFlag',
    filterValue: 'false',
    listModeKey: 'both',
    selectivity: 0.3,
  })
  expect(joined).toContain('SUM(contribution.contribution_value)')
  expect(contributionTotalStatement).not.toContain('AND contribution.summary_definition_version =')
  expect(joined).not.toContain('343341342341341300000')
})

test('full posting rebuilds write serving state without incremental patch fanout', async () => {
  const {database, statements} = createPostingDatabase({
    existingRows: [],
    newRows: [postingRow({filterKind: 'importRoute', filterValue: 'route-1'})],
  })

  const result = await projectReviewServingFilterPostings(projectInput([]), database)
  const joined = statements.join('\n')

  expect(result.patchRowCount).toBe(0)
  expect(result.servingRowCount).toBe(1)
  expect(result.validationResult).toMatchObject({
    actualCount: 1,
    diagnosticsJson: {validationMode: 'reused-source-posting-checksum'},
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
  expect(joined).toContain('INSERT INTO mart.review_article_filter_posting_serving_v4')
  expect(joined).toContain('INSERT INTO mart.review_article_summary_contribution_v4')
  expect(joined).toContain('WITH posting_source AS')
  expect(joined).toContain('SELECT DISTINCT')
  expect(joined).toContain('CAST(to_json(posting.filterKind) AS VARCHAR)')
})

test('full posting rebuilds scope set-based deletes to article ranges', async () => {
  const {database, statements} = createPostingDatabase({
    existingRows: [],
    newRows: [postingRow({articleId: 'article-2', filterKind: 'importRoute', filterValue: 'route-1'})],
  })

  await projectReviewServingFilterPostings(
    {...projectInput([]), chunkEndArticleId: 'article-9', chunkStartArticleId: 'article-2'},
    database,
  )

  const joined = statements.join('\n')

  expect(joined).toContain('DELETE FROM mart.review_article_filter_posting_serving_v4 serving')
  expect(joined).toContain('serving.article_id >=')
  expect(joined).toContain('serving.article_id <=')
  expect(joined).toContain('DELETE FROM mart.review_article_summary_contribution_v4 contribution')
  expect(joined).toContain('contribution.article_id >=')
  expect(joined).toContain('contribution.article_id <=')
})

test('deletes write tombstones, remove serving rows, and decrement stats in the writer transaction', async () => {
  const {database, statements} = createPostingDatabase({
    existingRows: [postingRow({filterKind: 'llmStatus', filterValue: 'answered'})],
    newRows: [],
    statsRows: [{cardinality: 4, filterKind: 'llmStatus', filterValue: 'answered', listModeKey: 'llm'}],
  })

  const result = await projectReviewServingFilterPostings(
    projectInput([postingClaim({dirtyKind: 'judgment.llm.deleted'})]),
    database,
  )
  const joined = statements.join('\n')

  expect(result.patchRowCount).toBe(1)
  expect(result.servingRowCount).toBe(0)
  expect(result.statsValues).toContainEqual({
    cardinality: 3,
    filterKind: 'llmStatus',
    filterValue: 'answered',
    listModeKey: 'llm',
    selectivity: 0.3,
  })
  expect(joined).toContain('DELETE FROM mart.review_article_filter_posting_serving_v4')
  expect(joined).toContain('TRUE')
  expect(joined).toContain('INSERT INTO app.review_serving_dirty_work_ack')
  expect(joined).toContain('INSERT INTO app.review_serving_projector_watermark')
})

test('membership removals scope through project_scope_article and tombstone existing postings', async () => {
  const {database, statements} = createPostingDatabase({
    existingRows: [postingRow({filterKind: 'importRoute', filterValue: 'route-1'})],
    newRows: [],
    statsRows: [{cardinality: 1, filterKind: 'importRoute', filterValue: 'route-1', listModeKey: 'llm'}],
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
    statsRows: [
      {cardinality: 5, filterKind: 'importRoute', filterValue: 'route-old', listModeKey: 'llm'},
      {cardinality: 1, filterKind: 'importRoute', filterValue: 'route-new', listModeKey: 'llm'},
    ],
  })

  const result = await projectReviewServingFilterPostings(
    projectInput([postingClaim({dirtyKind: 'importRoute.article.rankFields.updated'})]),
    database,
  )
  const selectStatement = statements.find((statement) => {
    return statement.includes('FROM posting_union')
  })

  expect(result.statsValues).toContainEqual({
    cardinality: 4,
    filterKind: 'importRoute',
    filterValue: 'route-old',
    listModeKey: 'llm',
    selectivity: 0.4,
  })
  expect(result.statsValues).toContainEqual({
    cardinality: 2,
    filterKind: 'importRoute',
    filterValue: 'route-new',
    listModeKey: 'llm',
    selectivity: 0.2,
  })
  expect(selectStatement).toContain('LEFT JOIN app.review_selected_article_import_v4 selected_base')
  expect(selectStatement).toContain('LEFT JOIN mart.review_selected_import_patch_v4 selected_patch')
  expect(selectStatement).toContain('COALESCE(selected_patch.tombstone, selected_base.tombstone, FALSE)')
  expect(selectStatement).toContain('COALESCE(selected_patch.duplicate_flag, selected_base.duplicate_flag, FALSE)')
  expect(selectStatement).toContain('COALESCE(selected_patch.conflict_flag, selected_base.conflict_flag, FALSE)')
  expect(selectStatement).toContain('scoped.scope_tombstone AS tombstone')
  expect(selectStatement).toContain('FROM mart.review_selected_import_patch_v4 newer')
  expect(selectStatement).toContain('newer.patch_watermark')
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

  expect(selectStatement).toContain('FROM mart.review_human_status_patch_v4 newer')
  expect(selectStatement).toContain('human.base_generation = 5')
  expect(selectStatement).toContain('newer.prompt_id IS NOT DISTINCT FROM human.prompt_id')
  expect(selectStatement).toContain('newer.list_mode_key = human.list_mode_key')
})

test('status postings use article-level all-prompt status rows', async () => {
  const {database, statements} = createPostingDatabase({newRows: []})

  await projectReviewServingFilterPostings(projectInput([postingClaim()], ['llm', 'human']), database)
  const selectStatement = statements.find((statement) => {
    return statement.includes('FROM posting_union')
  })

  expect(selectStatement).toContain('llm_article_status AS')
  expect(selectStatement).toContain("'llmStatus' AS filterKind, llm.llm_status_key AS filterValue")
  expect(selectStatement).toContain('human_article_status AS')
  expect(selectStatement).toContain("'humanStatus' AS filterKind, human.human_status_key AS filterValue")
  expect(selectStatement).toContain("COUNT(*) FILTER (WHERE NOT tombstone AND llm_status_key = 'answered')")
  expect(selectStatement).toContain('project_settings AS')
  expect(selectStatement).toContain("human_judgment_mode = 'summary'")
  expect(selectStatement).toContain("human.prompt_id = 'summary' AND human.human_status_key = 'answered'")
  expect(selectStatement).toContain("human.prompt_id <> 'summary' AND human.human_status_key = 'answered'")
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
  expect(selectStatement).toContain("THEN 'answered'")
})

test('prompt-answer postings encode prompt ids in filter values', async () => {
  const {database, statements} = createPostingDatabase({newRows: []})

  await projectReviewServingFilterPostings(projectInput([postingClaim()]), database)
  const selectStatement = statements.find((statement) => {
    return statement.includes('FROM posting_union')
  })

  expect(selectStatement).toContain("concat('review:promptAnswer:', llm.prompt_id, ':', llm.answered_original)")
  expect(selectStatement).toContain("concat('review:promptAnswer:', llm.prompt_id, ':', answer.answer_value)")
  expect(selectStatement).toContain("concat('human:promptAnswer:', human.prompt_id, ':', human.human_answered_value)")
  expect(selectStatement).toContain('llm.answered_original IS NOT NULL')
  expect(selectStatement).toContain('llm.answered_original_as_array IS NULL')
  expect(selectStatement).toContain('answer.answer_value IS NOT NULL')
  expect(selectStatement).toContain('human.human_answered_value IS NOT NULL')
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
    return statement.includes('DELETE FROM mart.review_article_filter_posting_serving_v4')
  })
  const existingSelect = statements.find((statement) => {
    return statement.includes('FROM mart.review_article_filter_posting_serving_v4 serving')
  })

  expect(existingSelect).not.toContain('article_id IN')
  expect(deleteStatement).toContain('USING deleted')
  expect(deleteStatement).toContain('filter_kind = deleted.filter_kind')
  expect(deleteStatement).toContain('snapshot_id')
  expect(deleteStatement).not.toContain('article_id IN')
  expect(deleteStatement).not.toContain('DELETE FROM mart.review_article_filter_posting_serving_v4 WHERE project_id')
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
    return statement.includes('DELETE FROM mart.review_article_filter_posting_serving_v4')
  })

  expect(deleteStatement).toContain('USING deleted')
  expect(deleteStatement).toContain('filter_kind = deleted.filter_kind')
  expect(deleteStatement).not.toContain('article_id IN')
})

test('list modes keep posting stats and serving rows separated', async () => {
  const {database} = createPostingDatabase({
    existingRows: [],
    newRows: [postingRow({listModeKey: 'llm'}), postingRow({listModeKey: 'human'})],
    statsRows: [],
    totalRows: [
      {listModeKey: 'llm', totalArticleCount: 10},
      {listModeKey: 'human', totalArticleCount: 5},
    ],
  })

  const result = await projectReviewServingFilterPostings(projectInput([postingClaim()], ['llm', 'human']), database)

  expect(result.servingRowCount).toBe(2)
  expect(result.statsValues).toContainEqual({
    cardinality: 1,
    filterKind: 'promptAnswer',
    filterValue: 'review:promptAnswer:prompt-1:yes',
    listModeKey: 'llm',
    selectivity: 0.1,
  })
  expect(result.statsValues).toContainEqual({
    cardinality: 1,
    filterKind: 'promptAnswer',
    filterValue: 'review:promptAnswer:prompt-1:yes',
    listModeKey: 'human',
    selectivity: 0.2,
  })
})
