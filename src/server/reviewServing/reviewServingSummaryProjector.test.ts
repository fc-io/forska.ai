import {existsSync, rmSync} from 'node:fs'

import {DuckDBInstance} from '@duckdb/node-api'
import {expect, test} from 'bun:test'

import {type ReviewServingDirtyWorkClaim} from './reviewServingDirtyWorkService.ts'
import {
  projectReviewServingSummaries,
  reduceReviewServingSummaryRebuildPartialsForRequestSnapshots,
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

const removeFileIfExists = (filePath: string) => {
  if (existsSync(filePath)) {
    rmSync(filePath, {force: true})
  }
}

const createDuckdbSummaryDatabase = async (
  duckdbPath: string,
): Promise<{close: () => void; database: ReviewServingSummaryProjectorDatabase}> => {
  const duckdbInstance = await DuckDBInstance.fromCache(duckdbPath, {memory_limit: '256MiB'})
  const connection = await duckdbInstance.connect()
  const database: ReviewServingSummaryProjectorDatabase = {
    queryJson: async <T>(statement: string) => {
      const reader = await connection.runAndReadAll(statement)

      return reader.getRowObjectsJson() as T[]
    },
    run: async (statement: string) => {
      await connection.run(statement)
    },
    transaction: async (operation) => {
      await connection.run('BEGIN')

      try {
        const result = await operation(database)
        await connection.run('COMMIT')

        return result
      } catch (error) {
        await connection.run('ROLLBACK')
        throw error
      }
    },
  }

  return {
    close: () => {
      connection.closeSync()
      duckdbInstance.closeSync()
    },
    database,
  }
}

const createSummaryReductionSchema = async (database: ReviewServingSummaryProjectorDatabase) => {
  await database.run('CREATE SCHEMA IF NOT EXISTS mart')
  await database.run(`
    CREATE TABLE mart.review_article_summary_rebuild_partial_v4 (
      request_id VARCHAR NOT NULL,
      chunk_id VARCHAR NOT NULL,
      project_id VARCHAR NOT NULL,
      review_config_hash VARCHAR NOT NULL,
      snapshot_id VARCHAR NOT NULL,
      serving_key VARCHAR NOT NULL,
      summary_kind VARCHAR NOT NULL,
      summary_identity VARCHAR NOT NULL,
      list_mode_key VARCHAR,
      count_kind VARCHAR,
      summary_definition_version VARCHAR NOT NULL,
      filter_key VARCHAR,
      facet_kind VARCHAR,
      facet_key VARCHAR,
      facet_value VARCHAR,
      prompt_id VARCHAR,
      answer_id INTEGER,
      answer_value VARCHAR,
      availability VARCHAR NOT NULL DEFAULT 'ready',
      stale_reason VARCHAR,
      count_value BIGINT,
      partial_updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
      PRIMARY KEY(request_id, chunk_id, project_id, review_config_hash, snapshot_id, serving_key)
    )
  `)
  await database.run(`
    CREATE TABLE mart.review_article_count_serving_v4 (
      project_id VARCHAR NOT NULL,
      review_config_hash VARCHAR NOT NULL,
      snapshot_id VARCHAR NOT NULL,
      summary_identity VARCHAR NOT NULL,
      list_mode_key VARCHAR NOT NULL DEFAULT 'global',
      count_kind VARCHAR NOT NULL,
      summary_definition_version VARCHAR NOT NULL,
      filter_key VARCHAR NOT NULL,
      count_value BIGINT,
      availability VARCHAR NOT NULL DEFAULT 'ready',
      stale_reason VARCHAR,
      count_updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
      PRIMARY KEY(project_id, review_config_hash, snapshot_id, list_mode_key, count_kind, summary_definition_version, filter_key)
    )
  `)
  await database.run(`
    CREATE TABLE mart.review_filter_facet_serving_v4 (
      project_id VARCHAR NOT NULL,
      review_config_hash VARCHAR NOT NULL,
      snapshot_id VARCHAR NOT NULL,
      summary_identity VARCHAR NOT NULL,
      facet_kind VARCHAR NOT NULL,
      facet_key VARCHAR NOT NULL,
      facet_value VARCHAR NOT NULL,
      prompt_id VARCHAR,
      answer_id INTEGER,
      answer_value VARCHAR,
      summary_definition_version VARCHAR NOT NULL,
      count_value BIGINT,
      availability VARCHAR NOT NULL DEFAULT 'ready',
      facet_updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
      PRIMARY KEY(project_id, review_config_hash, snapshot_id, summary_identity, facet_kind, facet_key, facet_value, summary_definition_version)
    )
  `)
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

  expect(result.diagnosticsJson.summaryProjector.sourceRowCount).toBe(1)
  expect(result.diagnosticsJson.phaseTimings.contributionDiffMs).toBeGreaterThanOrEqual(0)
  expect(result.diagnosticsJson.phaseTimings.contributionTransformMs).toBeGreaterThanOrEqual(0)
  expect(result.diagnosticsJson.phaseTimings.sourceQueryMs).toBeGreaterThanOrEqual(0)
  expect(result.diagnosticsJson.phaseTimings.summaryRecordBuildMs).toBeGreaterThanOrEqual(0)
  expect(result.diagnosticsJson.phaseTimings.writerMs).toBeGreaterThanOrEqual(0)
  expect(result.diagnosticsJson.summaryProjector.writer.records.inputRecordsByTable).toMatchObject({
    'mart.review_article_count_serving_v4': 2,
    'mart.review_article_summary_contribution_v4': 1,
  })
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
  expect(selectStatement).toContain(
    "COALESCE((SELECT project.human_judgment_mode FROM app.project project WHERE project.id = 'project-1'), 'prompt') AS human_judgment_mode",
  )
  expect(selectStatement).toContain("project_settings.human_judgment_mode <> 'summary'")
  expect(selectStatement).toContain("project_settings.human_judgment_mode = 'summary'")
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
  expect(selectStatement).toContain('llm.answered_original IS NOT NULL AND llm.answered_original_as_array IS NULL')
})

test('project-scoped summary rebuilds subtract prior contribution articles missing from new rows', async () => {
  const oldRow = sourceCountRow({articleId: 'article-old'})
  const {database, statements} = createSummaryDatabase({
    contributionRows: [storedContributionRow(oldRow)],
    countRows: [
      {countKind: 'review.llm.assessedByPrompt', countValue: 3, filterKey: 'prompt:prompt-1', listModeKey: 'llm'},
    ],
    sourceRows: [],
  })

  const result = await projectReviewServingSummaries(
    projectInput([
      summaryClaim({
        articleId: null,
        dirtyKind: 'project.reviewConfig.updated',
        scopeId: 'project-1',
        scopeKind: 'project',
      }),
    ]),
    database,
  )
  const priorArticleSelect = statements.find((statement) => {
    return statement.includes('SELECT DISTINCT contribution.article_id AS articleId')
  })
  const storedContributionSelect = statements.find((statement) => {
    return statement.includes("VALUES ('article-old')")
  })
  const projectedSummaryValue = result.summaryValues.find((row) => {
    return row.count_kind === 'review.llm.assessedByPrompt' && row.count_value === 2
  })

  expect(projectedSummaryValue?.count_updated_at).toBeInstanceOf(Date)
  expect(
    hasSummaryValue(result.summaryValues, {
      availability: 'ready',
      count_kind: 'review.llm.assessedByPrompt',
      count_value: 2,
      filter_key: 'prompt:prompt-1',
      list_mode_key: 'llm',
      project_id: 'project-1',
      review_config_hash: 'review-config-1',
      snapshot_id: 'snapshot-1',
      stale_reason: null,
      summary_definition_version: 'review-llm-assessed-by-prompt:v1',
      summary_identity: 'review.llm.assessedByPrompt',
    }),
  ).toBe(true)
  expect(priorArticleSelect).toContain("component_kind = 'count'")
  expect(storedContributionSelect).toBeDefined()
})

test('unchunked full summary rebuild writes final serving rows with contribution state', async () => {
  const {database, statements} = createSummaryDatabase({sourceRows: [sourceCountRow(), sourceFacetRow()]})

  const result = await projectReviewServingSummaries(projectInput([]), database)
  const joined = statements.join('\n')

  expect(result.contributionRowCount).toBe(2)
  expect(result.diagnosticsJson.summaryProjector).toMatchObject({directFullSnapshot: true})
  expect(result.diagnosticsJson.summaryProjector.writer.records.inputRecordsByTable).toMatchObject({
    'mart.review_article_count_serving_v4': 1,
    'mart.review_article_summary_contribution_v4': 2,
    'mart.review_filter_facet_serving_v4': 1,
  })
  expect(hasSummaryValue(result.summaryValues, {count_kind: 'review.llm.assessedByPrompt', count_value: 1})).toBe(true)
  expect(hasSummaryValue(result.summaryValues, {facet_key: 'summaryAnswer', count_value: 1})).toBe(true)
  expect(joined).toContain('DELETE FROM mart.review_article_count_serving_v4')
  expect(joined).toContain('DELETE FROM mart.review_filter_facet_serving_v4')
  expect(joined).toContain('INSERT INTO mart.review_article_count_serving_v4')
  expect(joined).toContain('INSERT INTO mart.review_filter_facet_serving_v4')
  expect(joined).not.toContain('SELECT DISTINCT contribution.article_id AS articleId')
  expect(joined).toContain('DELETE FROM mart.review_article_summary_contribution_v4')
  expect(
    statements.find((statement) => {
      return statement.includes('DELETE FROM mart.review_article_summary_contribution_v4')
    }),
  ).not.toContain('summary_definition_version')
  expect(joined).toContain('INSERT INTO mart.review_article_summary_contribution_v4')
})

test('chunked full summary rebuild writes request partials and contribution state without final serving rows', async () => {
  const {database, statements} = createSummaryDatabase({sourceRows: [sourceCountRow(), sourceFacetRow()]})

  const result = await projectReviewServingSummaries(
    {
      ...projectInput([]),
      chunkEndArticleId: 'article-099',
      chunkId: 'chunk-summary-1',
      chunkStartArticleId: 'article-001',
      requestId: 'rebuild-summary-1',
    },
    database,
  )
  const joined = statements.join('\n')

  expect(result.contributionRowCount).toBe(2)
  expect(result.diagnosticsJson.summaryProjector).toMatchObject({
    contributionRecordCount: 2,
    directFullSnapshot: true,
    partialFullSnapshot: true,
    partialRowCount: 2,
  })
  expect(result.diagnosticsJson.summaryProjector.writer.records.inputRecordsByTable).toMatchObject({
    'mart.review_article_summary_contribution_v4': 2,
    'mart.review_article_summary_rebuild_partial_v4': 2,
  })
  expect(joined).toContain('DELETE FROM mart.review_article_summary_rebuild_partial_v4')
  expect(joined).toContain('DELETE FROM mart.review_article_summary_contribution_v4 contribution')
  expect(joined).toContain('INSERT INTO mart.review_article_summary_rebuild_partial_v4')
  expect(joined).toContain('INSERT INTO mart.review_article_summary_contribution_v4')
  expect(joined).toContain("article_id >= 'article-001'")
  expect(joined).toContain("article_id <= 'article-099'")
  expect(joined).not.toContain('INSERT INTO mart.review_article_count_serving_v4')
  expect(joined).not.toContain('INSERT INTO mart.review_filter_facet_serving_v4')
})

test('summary rebuild request finalization reduces partials in bounded accumulator batches', async () => {
  const statements: string[] = []
  const chunkBatches = [[{chunkId: 'chunk-001'}, {chunkId: 'chunk-002'}], [{chunkId: 'chunk-003'}], []]
  const database: ReviewServingSummaryProjectorDatabase = {
    queryJson: async <T>(statement: string) => {
      statements.push(statement)

      if (statement.includes('COUNT(*) AS partialCount')) {
        return [{partialCount: 1}] as T[]
      }

      return (chunkBatches.shift() ?? []) as T[]
    },
    run: async (statement: string) => {
      statements.push(statement)
    },
    transaction: async (operation) => {
      statements.push('BEGIN')

      return operation(database)
    },
  }

  await reduceReviewServingSummaryRebuildPartialsForRequestSnapshots(
    {
      requestId: 'rebuild-summary-1',
      snapshots: [{projectId: 'project-1', reviewConfigHash: 'review-config-1', snapshotId: 'snapshot-1'}],
    },
    database,
  )
  const joined = statements.join('\n')
  const batchSelects = statements.filter((statement) => {
    return statement.includes('GROUP BY chunk_id')
  })
  const accumulatorWrites = statements.filter((statement) => {
    return statement.includes("'__summary_rebuild_partial_accumulator__' AS chunk_id")
  })

  expect(batchSelects).toHaveLength(3)
  expect(accumulatorWrites).toHaveLength(2)
  expect(batchSelects[0]).toContain('LIMIT 256')
  expect(batchSelects[0]).toContain("chunk_id <> '__summary_rebuild_partial_accumulator__'")
  expect(joined).toContain("chunk_id IN ('chunk-001', 'chunk-002')")
  expect(joined).toContain("chunk_id IN ('chunk-003')")
  expect(joined).toContain(
    'ON CONFLICT(request_id, chunk_id, project_id, review_config_hash, snapshot_id, serving_key) DO UPDATE SET',
  )
  expect(joined).toContain("AND chunk_id = '__summary_rebuild_partial_accumulator__'")
  expect(joined).toContain('DELETE FROM mart.review_article_summary_rebuild_partial_v4')
})

test('summary rebuild request finalization reduces conflicting partial chunks in DuckDB', async () => {
  const duckdbPath = `/tmp/forska-summary-partial-finalize-${Date.now()}.duckdb`

  try {
    const {close, database} = await createDuckdbSummaryDatabase(duckdbPath)

    try {
      await createSummaryReductionSchema(database)
      await database.run(`
        INSERT INTO mart.review_article_summary_rebuild_partial_v4 (
          request_id,
          chunk_id,
          project_id,
          review_config_hash,
          snapshot_id,
          serving_key,
          summary_kind,
          summary_identity,
          list_mode_key,
          count_kind,
          summary_definition_version,
          filter_key,
          count_value
        ) VALUES
          ('rebuild-summary-1', 'chunk-001', 'project-1', 'review-config-1', 'snapshot-1', 'count-key', 'count', 'review.llm.assessedByPrompt', 'llm', 'review.llm.assessedByPrompt', 'review-llm-assessed-by-prompt:v1', 'prompt:prompt-1', 2),
          ('rebuild-summary-1', 'chunk-002', 'project-1', 'review-config-1', 'snapshot-1', 'count-key', 'count', 'review.llm.assessedByPrompt', 'llm', 'review.llm.assessedByPrompt', 'review-llm-assessed-by-prompt:v1', 'prompt:prompt-1', 3)
      `)

      await reduceReviewServingSummaryRebuildPartialsForRequestSnapshots(
        {
          requestId: 'rebuild-summary-1',
          snapshots: [{projectId: 'project-1', reviewConfigHash: 'review-config-1', snapshotId: 'snapshot-1'}],
        },
        database,
      )
      const countRows = await database.queryJson<{countValue: string}>(`
        SELECT CAST(count_value AS VARCHAR) AS countValue
        FROM mart.review_article_count_serving_v4
      `)
      const partialRows = await database.queryJson<{total: string}>(`
        SELECT CAST(COUNT(*) AS VARCHAR) AS total
        FROM mart.review_article_summary_rebuild_partial_v4
      `)

      expect(countRows).toEqual([{countValue: '5'}])
      expect(partialRows).toEqual([{total: '0'}])
    } finally {
      close()
    }
  } finally {
    removeFileIfExists(duckdbPath)
  }
})

test('summary rebuild request finalization leaves serving summaries unchanged when no partials exist', async () => {
  const duckdbPath = `/tmp/forska-summary-partial-noop-${Date.now()}.duckdb`

  try {
    const {close, database} = await createDuckdbSummaryDatabase(duckdbPath)

    try {
      await createSummaryReductionSchema(database)
      await database.run(`
        INSERT INTO mart.review_article_count_serving_v4 (
          project_id,
          review_config_hash,
          snapshot_id,
          summary_identity,
          list_mode_key,
          count_kind,
          summary_definition_version,
          filter_key,
          count_value
        ) VALUES (
          'project-1',
          'review-config-1',
          'snapshot-1',
          'review.llm.assessedByPrompt',
          'llm',
          'review.llm.assessedByPrompt',
          'review-llm-assessed-by-prompt:v1',
          'prompt:prompt-1',
          7
        )
      `)
      await database.run(`
        INSERT INTO mart.review_filter_facet_serving_v4 (
          project_id,
          review_config_hash,
          snapshot_id,
          summary_identity,
          facet_kind,
          facet_key,
          facet_value,
          summary_definition_version,
          count_value
        ) VALUES (
          'project-1',
          'review-config-1',
          'snapshot-1',
          'review.filter.promptAnswer',
          'review',
          'promptAnswer',
          'old-answer',
          'review-filter-prompt-answer:v1',
          9
        )
      `)

      await reduceReviewServingSummaryRebuildPartialsForRequestSnapshots(
        {
          requestId: 'rebuild-posting-only-1',
          snapshots: [{projectId: 'project-1', reviewConfigHash: 'review-config-1', snapshotId: 'snapshot-1'}],
        },
        database,
      )
      const countRows = await database.queryJson<{countValue: string}>(`
        SELECT CAST(count_value AS VARCHAR) AS countValue
        FROM mart.review_article_count_serving_v4
      `)
      const facetRows = await database.queryJson<{countValue: string}>(`
        SELECT CAST(count_value AS VARCHAR) AS countValue
        FROM mart.review_filter_facet_serving_v4
      `)

      expect(countRows).toEqual([{countValue: '7'}])
      expect(facetRows).toEqual([{countValue: '9'}])
    } finally {
      close()
    }
  } finally {
    removeFileIfExists(duckdbPath)
  }
})

test('summary rebuild request finalization deletes stale serving rows when summary chunks produced no partials', async () => {
  const duckdbPath = `/tmp/forska-summary-partial-empty-summary-${Date.now()}.duckdb`

  try {
    const {close, database} = await createDuckdbSummaryDatabase(duckdbPath)

    try {
      await createSummaryReductionSchema(database)
      await database.run(`
        INSERT INTO mart.review_article_count_serving_v4 (
          project_id,
          review_config_hash,
          snapshot_id,
          summary_identity,
          list_mode_key,
          count_kind,
          summary_definition_version,
          filter_key,
          count_value
        ) VALUES (
          'project-1',
          'review-config-1',
          'snapshot-1',
          'review.llm.assessedByPrompt',
          'llm',
          'review.llm.assessedByPrompt',
          'review-llm-assessed-by-prompt:v1',
          'prompt:prompt-1',
          7
        )
      `)
      await database.run(`
        INSERT INTO mart.review_filter_facet_serving_v4 (
          project_id,
          review_config_hash,
          snapshot_id,
          summary_identity,
          facet_kind,
          facet_key,
          facet_value,
          summary_definition_version,
          count_value
        ) VALUES (
          'project-1',
          'review-config-1',
          'snapshot-1',
          'review.filter.promptAnswer',
          'review',
          'promptAnswer',
          'old-answer',
          'review-filter-prompt-answer:v1',
          9
        )
      `)

      await reduceReviewServingSummaryRebuildPartialsForRequestSnapshots(
        {
          requestId: 'rebuild-empty-summary-1',
          snapshots: [
            {
              hasSummaryRebuildChunks: true,
              projectId: 'project-1',
              reviewConfigHash: 'review-config-1',
              snapshotId: 'snapshot-1',
            },
          ],
        },
        database,
      )
      const countRows = await database.queryJson<{total: string}>(`
        SELECT CAST(COUNT(*) AS VARCHAR) AS total
        FROM mart.review_article_count_serving_v4
      `)
      const facetRows = await database.queryJson<{total: string}>(`
        SELECT CAST(COUNT(*) AS VARCHAR) AS total
        FROM mart.review_filter_facet_serving_v4
      `)

      expect(countRows).toEqual([{total: '0'}])
      expect(facetRows).toEqual([{total: '0'}])
    } finally {
      close()
    }
  } finally {
    removeFileIfExists(duckdbPath)
  }
})

test('summary rebuild request finalization skips null-hash snapshots without summary chunks', async () => {
  const {database, statements} = createSummaryDatabase()

  await reduceReviewServingSummaryRebuildPartialsForRequestSnapshots(
    {
      requestId: 'rebuild-selected-import-only-1',
      snapshots: [
        {hasSummaryRebuildChunks: false, projectId: 'project-1', reviewConfigHash: null, snapshotId: 'snapshot-1'},
      ],
    },
    database,
  )

  expect(statements).toEqual([])
})

test('summary rebuild request finalization deletes stale facets when no facet partials remain', async () => {
  const duckdbPath = `/tmp/forska-summary-partial-empty-facet-${Date.now()}.duckdb`

  try {
    const {close, database} = await createDuckdbSummaryDatabase(duckdbPath)

    try {
      await createSummaryReductionSchema(database)
      await database.run(`
        INSERT INTO mart.review_article_summary_rebuild_partial_v4 (
          request_id,
          chunk_id,
          project_id,
          review_config_hash,
          snapshot_id,
          serving_key,
          summary_kind,
          summary_identity,
          list_mode_key,
          count_kind,
          summary_definition_version,
          filter_key,
          count_value
        ) VALUES (
          'rebuild-summary-1',
          'chunk-001',
          'project-1',
          'review-config-1',
          'snapshot-1',
          'count-key',
          'count',
          'review.llm.assessedByPrompt',
          'llm',
          'review.llm.assessedByPrompt',
          'review-llm-assessed-by-prompt:v1',
          'prompt:prompt-1',
          3
        )
      `)
      await database.run(`
        INSERT INTO mart.review_filter_facet_serving_v4 (
          project_id,
          review_config_hash,
          snapshot_id,
          summary_identity,
          facet_kind,
          facet_key,
          facet_value,
          summary_definition_version,
          count_value
        ) VALUES (
          'project-1',
          'review-config-1',
          'snapshot-1',
          'review.filter.promptAnswer',
          'review',
          'promptAnswer',
          'old-answer',
          'review-filter-prompt-answer:v1',
          9
        )
      `)

      await reduceReviewServingSummaryRebuildPartialsForRequestSnapshots(
        {
          requestId: 'rebuild-summary-1',
          snapshots: [{projectId: 'project-1', reviewConfigHash: 'review-config-1', snapshotId: 'snapshot-1'}],
        },
        database,
      )
      const facetRows = await database.queryJson<{total: string}>(`
        SELECT CAST(COUNT(*) AS VARCHAR) AS total
        FROM mart.review_filter_facet_serving_v4
      `)

      expect(facetRows).toEqual([{total: '0'}])
    } finally {
      close()
    }
  } finally {
    removeFileIfExists(duckdbPath)
  }
})

test('unchunked full summary rebuild aggregates shared facet serving keys', async () => {
  const {database} = createSummaryDatabase({
    sourceRows: [
      sourceFacetRow({articleId: 'article-1', promptId: 'prompt-1'}),
      sourceFacetRow({articleId: 'article-2', promptId: 'prompt-2'}),
    ],
  })

  const result = await projectReviewServingSummaries(projectInput([]), database)

  expect(
    result.summaryValues.filter((row) => {
      return row.facet_key === 'summaryAnswer' && row.facet_value === 'yes'
    }),
  ).toHaveLength(1)
  expect(hasSummaryValue(result.summaryValues, {facet_key: 'summaryAnswer', facet_value: 'yes', count_value: 2})).toBe(
    true,
  )
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

test('prompt badge counts flow through summary contribution rows used by review.prompt.badges', async () => {
  const badgeRows = [
    sourceCountRow({
      countKind: 'review.llm.assessedByPrompt',
      filterKey: 'prompt:prompt-1',
      listModeKey: 'llm',
      summaryIdentity: 'review.llm.assessedByPrompt',
    }),
    sourceCountRow({
      countKind: 'review.llm.unassessedByPrompt',
      filterKey: 'prompt:prompt-1',
      listModeKey: 'llm',
      summaryIdentity: 'review.llm.unassessedByPrompt',
    }),
    sourceCountRow({
      countKind: 'review.human.reviewedByPrompt',
      filterKey: 'prompt:prompt-1',
      listModeKey: 'human',
      summaryIdentity: 'review.human.reviewedByPrompt',
    }),
    sourceCountRow({
      countKind: 'review.both.conflictByPrompt',
      filterKey: 'prompt:prompt-1',
      listModeKey: 'both',
      summaryIdentity: 'review.both.conflictByPrompt',
    }),
  ]
  const {database, statements} = createSummaryDatabase({sourceRows: badgeRows})
  const result = await projectReviewServingSummaries(projectInput([summaryClaim()], ['llm', 'human', 'both']), database)
  const joined = statements.join('\n')

  expect(
    [
      'review.llm.assessedByPrompt',
      'review.llm.unassessedByPrompt',
      'review.human.reviewedByPrompt',
      'review.both.conflictByPrompt',
    ].every((countKind) => {
      return hasSummaryValue(result.summaryValues, {count_kind: countKind, count_value: 1})
    }),
  ).toBe(true)
  expect(joined).toContain('INSERT INTO mart.review_article_count_serving_v4')
  expect(joined).toContain('INSERT INTO mart.review_article_summary_contribution_v4')
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
  expect(joined).toContain('INSERT INTO mart.review_article_summary_contribution_v4')
})

test('deferred summary option phases do not publish manifests or watermarks', async () => {
  const {database, statements} = createSummaryDatabase({sourceRows: [sourceCountRow()]})

  await projectReviewServingSummaries({...projectInput([summaryClaim()]), acknowledgeClaims: false}, database)
  const joined = statements.join('\n')

  expect(joined).not.toContain('INSERT INTO app.review_serving_projection_manifest')
  expect(joined).not.toContain('INSERT INTO app.review_serving_projector_watermark')
})
