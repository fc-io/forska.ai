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

const createSummaryDatabase = (input?: {
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
  await database.run('CREATE SCHEMA IF NOT EXISTS app')
  await database.run('CREATE SCHEMA IF NOT EXISTS mart')
  await database.run(`
    CREATE TABLE app.review_rebuild_chunk_manifest (
      request_id VARCHAR NOT NULL,
      chunk_id VARCHAR NOT NULL,
      project_id VARCHAR,
      snapshot_id VARCHAR,
      projection_component VARCHAR NOT NULL,
      status VARCHAR NOT NULL
    )
  `)
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
    CREATE TABLE mart.review_article_summary_contribution_rebuild_partial_v4 (
      request_id VARCHAR NOT NULL,
      chunk_id VARCHAR NOT NULL,
      project_id VARCHAR NOT NULL,
      review_config_hash VARCHAR NOT NULL,
      snapshot_id VARCHAR NOT NULL,
      article_id VARCHAR NOT NULL,
      component_kind VARCHAR NOT NULL,
      summary_definition_version VARCHAR NOT NULL,
      contribution_key VARCHAR NOT NULL,
      contribution_value BIGINT NOT NULL,
      contribution_updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
      PRIMARY KEY(request_id, chunk_id, project_id, review_config_hash, snapshot_id, article_id, component_kind, summary_definition_version, contribution_key)
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

const insertSummaryChunkManifestRows = async (
  database: ReviewServingSummaryProjectorDatabase,
  input: {chunkIds: readonly string[]; requestId?: string; status?: string},
) => {
  const requestId = input.requestId ?? 'rebuild-summary-1'
  const status = input.status ?? 'completed'
  const values = input.chunkIds
    .map((chunkId) => {
      return `('${requestId}', '${chunkId}', 'project-1', 'snapshot-1', 'summary', '${status}')`
    })
    .join(', ')

  await database.run(`
    INSERT INTO app.review_rebuild_chunk_manifest (
      request_id,
      chunk_id,
      project_id,
      snapshot_id,
      projection_component,
      status
    ) VALUES ${values}
  `)
}

const hasSummaryValue = (rows: readonly Record<string, unknown>[], expected: Record<string, unknown>) => {
  return rows.some((row) => {
    return Object.entries(expected).every(([key, value]) => {
      return row[key] === value
    })
  })
}

test('projects list-mode count replacements with summary identity and definition version', async () => {
  const newRow = sourceCountRow({listModeKey: 'llm'})
  const {database, statements} = createSummaryDatabase({sourceRows: [newRow]})

  const result = await projectReviewServingSummaries(projectInput([summaryClaim()], ['llm', 'human']), database)
  const joined = statements.join('\n')

  expect(result.diagnosticsJson.summaryProjector.sourceRowCount).toBe(1)
  expect(result.diagnosticsJson.summaryProjector).toMatchObject({directServingRecompute: true})
  expect(result.diagnosticsJson.phaseTimings.contributionTransformMs).toBeGreaterThanOrEqual(0)
  expect(result.diagnosticsJson.phaseTimings.sourceQueryMs).toBeGreaterThanOrEqual(0)
  expect(result.diagnosticsJson.phaseTimings.summaryRecordBuildMs).toBeGreaterThanOrEqual(0)
  expect(result.diagnosticsJson.phaseTimings.writerMs).toBeGreaterThanOrEqual(0)
  expect(result.diagnosticsJson.summaryProjector.writer.records.inputRecordsByTable).toMatchObject({
    'mart.review_article_count_serving_v4': 1,
  })
  expect(
    hasSummaryValue(result.summaryValues, {
      count_kind: 'review.llm.assessedByPrompt',
      count_value: 1,
      filter_key: 'prompt:prompt-1',
      list_mode_key: 'llm',
      summary_definition_version: 'review-llm-assessed-by-prompt:v1',
      summary_identity: 'review.llm.assessedByPrompt',
    }),
  ).toBe(true)
  expect(joined).toContain('FROM scoped_serving serving')
  expect(joined).toContain('serving.selected_import_route_id AS import_route_id')
  expect(joined).toContain('serving.duplicate_flag')
  expect(joined).toContain('serving.conflict_flag')
  expect(joined).toContain('mart.review_article_judgment_detail_serving_v4 detail')
  expect(joined).not.toContain('mart.review_selected_import_patch_v4')
  expect(joined).toContain('DELETE FROM mart.review_article_count_serving_v4')
  expect(joined).toContain('DELETE FROM mart.review_filter_facet_serving_v4')
  expect(joined).toContain('INSERT INTO mart.review_article_count_serving_v4')
  expect(joined).not.toContain('mart.review_article_summary_contribution_v4')
})

test('dirty summary recompute scopes source reads to claimed articles', async () => {
  const {database, statements} = createSummaryDatabase({sourceRows: [sourceCountRow()]})

  await projectReviewServingSummaries(
    projectInput([
      summaryClaim({articleId: 'article-1'}),
      summaryClaim({articleId: 'article-2', dirtyWorkId: 'dirty-work-2', scopeId: 'project-1:article-2'}),
    ]),
    database,
  )
  const sourceStatement = statements.find((statement) => {
    return statement.includes('FROM summary_union')
  })

  expect(sourceStatement).toContain(
    "article_id_filter(article_id) AS (SELECT * FROM (VALUES ('article-1'), ('article-2')))",
  )
  expect(sourceStatement).not.toContain('FROM mart.project_scope_article scope')
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
      count_value: 1,
      facet_key: 'summaryAnswer',
      facet_kind: 'human',
      facet_value: 'yes',
      prompt_id: 'summary',
      summary_definition_version: 'review-human-filter-summary-answer:v1',
      summary_identity: 'review.human.filter.summaryAnswer',
    }),
  ).toBe(true)
  expect(selectStatement).not.toContain('mart.review_human_status_patch_v4')
  expect(selectStatement).toContain('mart.review_article_judgment_detail_serving_v4 detail')
  expect(selectStatement).toContain(
    "COALESCE((SELECT project.human_judgment_mode FROM app.project project WHERE project.id = 'project-1'), 'prompt') AS human_judgment_mode",
  )
  expect(selectStatement).toContain("project_settings.human_judgment_mode <> 'summary'")
  expect(selectStatement).toContain("project_settings.human_judgment_mode = 'summary'")
  expect(selectStatement).toContain('human.prompt_id')
  expect(selectStatement).toContain(
    "human.answered_original IS NOT NULL OR COALESCE(TRY_CAST(json_extract_string(human.judgment_payload_json, '$.isAnswered') AS BOOLEAN), FALSE)",
  )
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

test('project-scoped summary rebuilds replace stale serving summaries without contribution state', async () => {
  const {database, statements} = createSummaryDatabase({sourceRows: []})

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
  const joined = statements.join('\n')

  expect(result.summaryValues).toEqual([])
  expect(joined).toContain('DELETE FROM mart.review_article_count_serving_v4')
  expect(joined).toContain('DELETE FROM mart.review_filter_facet_serving_v4')
  expect(joined).not.toContain('mart.review_article_summary_contribution_v4')
})

test('unchunked full summary rebuild writes final serving rows without contribution state', async () => {
  const {database, statements} = createSummaryDatabase({sourceRows: [sourceCountRow(), sourceFacetRow()]})

  const result = await projectReviewServingSummaries(projectInput([]), database)
  const joined = statements.join('\n')

  expect(result.contributionRowCount).toBe(0)
  expect(result.diagnosticsJson.summaryProjector).toMatchObject({contributionRecordCount: 0, directFullSnapshot: true})
  expect(result.diagnosticsJson.summaryProjector.writer.records.inputRecordsByTable).toMatchObject({
    'mart.review_article_count_serving_v4': 1,
    'mart.review_filter_facet_serving_v4': 1,
  })
  expect(hasSummaryValue(result.summaryValues, {count_kind: 'review.llm.assessedByPrompt', count_value: 1})).toBe(true)
  expect(hasSummaryValue(result.summaryValues, {facet_key: 'summaryAnswer', count_value: 1})).toBe(true)
  expect(joined).toContain('DELETE FROM mart.review_article_count_serving_v4')
  expect(joined).toContain('DELETE FROM mart.review_filter_facet_serving_v4')
  expect(joined).toContain('INSERT INTO mart.review_article_count_serving_v4')
  expect(joined).toContain('INSERT INTO mart.review_filter_facet_serving_v4')
  expect(joined).not.toContain('mart.review_article_summary_contribution_v4')
  expect(joined).toContain('INNER JOIN mart.review_article_serving_v4 serving')
  expect(joined).toContain('INNER JOIN mart.review_article_judgment_detail_serving_v4 detail')
  expect(joined).not.toContain('FROM mart.review_llm_status_patch_v4 llm')
  expect(joined).not.toContain('FROM mart.review_human_status_patch_v4 human')
  expect(joined).not.toContain('SELECT DISTINCT contribution.article_id AS articleId')
})

test('chunked full summary rebuild stages request partials and contribution partials without final serving rows', async () => {
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
    'mart.review_article_summary_contribution_rebuild_partial_v4': 2,
    'mart.review_article_summary_rebuild_partial_v4': 2,
  })
  expect(joined).toContain('DELETE FROM mart.review_article_summary_rebuild_partial_v4')
  expect(joined).toContain('DELETE FROM mart.review_article_summary_contribution_rebuild_partial_v4')
  expect(joined).toContain('INSERT INTO mart.review_article_summary_rebuild_partial_v4')
  expect(joined).toContain('INSERT INTO mart.review_article_summary_contribution_rebuild_partial_v4')
  expect(joined).toContain('INNER JOIN mart.review_article_serving_v4 serving')
  expect(joined).toContain('INNER JOIN mart.review_article_judgment_detail_serving_v4 detail')
  expect(joined).not.toContain('FROM mart.review_llm_status_patch_v4 llm')
  expect(joined).not.toContain('FROM mart.review_human_status_patch_v4 human')
  expect(joined).not.toContain('mart.review_article_summary_contribution_v4')
  expect(joined).not.toContain('INSERT INTO mart.review_article_count_serving_v4')
  expect(joined).not.toContain('INSERT INTO mart.review_filter_facet_serving_v4')
})

test('summary rebuild request finalization reduces partials in bounded accumulator batches', async () => {
  const statements: string[] = []
  const chunkBatches = [[{chunkId: 'chunk-001'}, {chunkId: 'chunk-002'}], [{chunkId: 'chunk-003'}], []]
  const database: ReviewServingSummaryProjectorDatabase = {
    queryJson: async <T>(statement: string) => {
      statements.push(statement)

      if (statement.includes('SELECT chunk.chunk_id AS chunkId')) {
        return [{chunkId: 'chunk-001'}, {chunkId: 'chunk-002'}, {chunkId: 'chunk-003'}] as T[]
      }

      if (statement.includes('partialCount')) {
        return [{partialCount: 1}] as T[]
      }

      return (chunkBatches.shift() ?? []) as T[]
    },
    run: async (statement: string) => {
      statements.push(statement)
    },
    transaction: async (operation) => {
      statements.push('BEGIN')

      return await operation(database)
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
    return statement.includes('GROUP BY partial.chunk_id')
  })
  const accumulatorWrites = statements.filter((statement) => {
    return statement.includes("'__summary_rebuild_partial_accumulator__:") && statement.includes(' AS chunk_id')
  })

  expect(batchSelects).toHaveLength(3)
  expect(accumulatorWrites).toHaveLength(2)
  expect(joined).toContain('chunk.snapshot_id = ')
  expect(batchSelects[0]).toContain('LIMIT 256')
  expect(batchSelects[0]).toContain('INNER JOIN app.review_rebuild_chunk_manifest chunk')
  expect(batchSelects[0]).toContain("chunk.status = 'completed'")
  expect(batchSelects[0]).toContain("partial.chunk_id NOT LIKE '__summary_rebuild_partial_accumulator__:%'")
  expect(joined).toContain("chunk_id IN ('chunk-001', 'chunk-002')")
  expect(joined).toContain("chunk_id IN ('chunk-003')")
  expect(joined).toContain(
    'ON CONFLICT(request_id, chunk_id, project_id, review_config_hash, snapshot_id, serving_key) DO UPDATE SET',
  )
  expect(joined).toContain("AND chunk_id = '__summary_rebuild_partial_accumulator__:")
  expect(joined).toContain('DELETE FROM mart.review_article_summary_rebuild_partial_v4')
  expect(joined).toContain('FROM mart.review_article_summary_contribution_rebuild_partial_v4')
  expect(joined).not.toContain('mart.review_article_summary_contribution_v4')
  expect(
    statements.filter((statement) => {
      return statement.includes('DELETE FROM mart.review_article_summary_contribution_rebuild_partial_v4')
    }),
  ).toHaveLength(0)
})

test('summary rebuild request finalization reduces conflicting partial chunks in DuckDB', async () => {
  const duckdbPath = `/tmp/forska-summary-partial-finalize-${Date.now()}.duckdb`

  try {
    const {close, database} = await createDuckdbSummaryDatabase(duckdbPath)

    try {
      await createSummaryReductionSchema(database)
      await insertSummaryChunkManifestRows(database, {chunkIds: ['chunk-001', 'chunk-002']})
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
      expect(partialRows).toEqual([{total: '1'}])
    } finally {
      close()
    }
  } finally {
    removeFileIfExists(duckdbPath)
  }
})

test('summary rebuild request finalization ignores stale partial chunks without completed manifests', async () => {
  const duckdbPath = `/tmp/forska-summary-stale-partial-finalize-${Date.now()}.duckdb`

  try {
    const {close, database} = await createDuckdbSummaryDatabase(duckdbPath)

    try {
      await createSummaryReductionSchema(database)
      await insertSummaryChunkManifestRows(database, {chunkIds: ['chunk-current']})
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
          ('rebuild-summary-1', 'chunk-current', 'project-1', 'review-config-1', 'snapshot-1', 'count-key', 'count', 'review.llm.assessedByPrompt', 'llm', 'review.llm.assessedByPrompt', 'review-llm-assessed-by-prompt:v1', 'prompt:prompt-1', 3),
          ('rebuild-summary-1', 'chunk-stale', 'project-1', 'review-config-1', 'snapshot-1', 'count-key', 'count', 'review.llm.assessedByPrompt', 'llm', 'review.llm.assessedByPrompt', 'review-llm-assessed-by-prompt:v1', 'prompt:prompt-1', 99)
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

      expect(countRows).toEqual([{countValue: '3'}])
    } finally {
      close()
    }
  } finally {
    removeFileIfExists(duckdbPath)
  }
})

test('summary rebuild request finalization ignores stale accumulator rows from prior chunk sets', async () => {
  const duckdbPath = `/tmp/forska-summary-stale-accumulator-finalize-${Date.now()}.duckdb`

  try {
    const {close, database} = await createDuckdbSummaryDatabase(duckdbPath)

    try {
      await createSummaryReductionSchema(database)
      await insertSummaryChunkManifestRows(database, {chunkIds: ['chunk-current']})
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
          ('rebuild-summary-1', '__summary_rebuild_partial_accumulator__:stale', 'project-1', 'review-config-1', 'snapshot-1', 'count-key', 'count', 'review.llm.assessedByPrompt', 'llm', 'review.llm.assessedByPrompt', 'review-llm-assessed-by-prompt:v1', 'prompt:prompt-1', 99),
          ('rebuild-summary-1', 'chunk-current', 'project-1', 'review-config-1', 'snapshot-1', 'count-key', 'count', 'review.llm.assessedByPrompt', 'llm', 'review.llm.assessedByPrompt', 'review-llm-assessed-by-prompt:v1', 'prompt:prompt-1', 3)
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

      expect(countRows).toEqual([{countValue: '3'}])
      expect(partialRows).toEqual([{total: '1'}])
    } finally {
      close()
    }
  } finally {
    removeFileIfExists(duckdbPath)
  }
})

test('summary rebuild request finalization deduplicates overlapping contribution partial counts', async () => {
  const duckdbPath = `/tmp/forska-summary-duplicate-contribution-finalize-${Date.now()}.duckdb`
  const countContributionKey = contributionKey({
    answerId: null,
    answerValue: null,
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
  })
  const facetContributionKey = contributionKey({
    answerId: null,
    answerValue: 'yes',
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
  })

  try {
    const {close, database} = await createDuckdbSummaryDatabase(duckdbPath)

    try {
      await createSummaryReductionSchema(database)
      await insertSummaryChunkManifestRows(database, {chunkIds: ['chunk-left', 'chunk-right']})
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
          facet_kind,
          facet_key,
          facet_value,
          prompt_id,
          answer_value,
          count_value
        ) VALUES
          ('rebuild-summary-1', 'chunk-left', 'project-1', 'review-config-1', 'snapshot-1', 'count-key', 'count', 'review.llm.assessedByPrompt', 'llm', 'review.llm.assessedByPrompt', 'review-llm-assessed-by-prompt:v1', 'prompt:prompt-1', NULL, NULL, NULL, 'prompt-1', NULL, 2),
          ('rebuild-summary-1', 'chunk-right', 'project-1', 'review-config-1', 'snapshot-1', 'count-key', 'count', 'review.llm.assessedByPrompt', 'llm', 'review.llm.assessedByPrompt', 'review-llm-assessed-by-prompt:v1', 'prompt:prompt-1', NULL, NULL, NULL, 'prompt-1', NULL, 2),
          ('rebuild-summary-1', 'chunk-left', 'project-1', 'review-config-1', 'snapshot-1', 'facet-key', 'facet', 'review.human.filter.summaryAnswer', NULL, 'review.human.filter.summaryAnswer', 'review-human-filter-summary-answer:v1', NULL, 'human', 'summaryAnswer', 'yes', 'summary', 'yes', 2),
          ('rebuild-summary-1', 'chunk-right', 'project-1', 'review-config-1', 'snapshot-1', 'facet-key', 'facet', 'review.human.filter.summaryAnswer', NULL, 'review.human.filter.summaryAnswer', 'review-human-filter-summary-answer:v1', NULL, 'human', 'summaryAnswer', 'yes', 'summary', 'yes', 2)
      `)
      await database.run(`
        INSERT INTO mart.review_article_summary_contribution_rebuild_partial_v4 (
          request_id,
          chunk_id,
          project_id,
          review_config_hash,
          snapshot_id,
          article_id,
          component_kind,
          summary_definition_version,
          contribution_key,
          contribution_value
        ) VALUES
          ('rebuild-summary-1', 'chunk-left', 'project-1', 'review-config-1', 'snapshot-1', 'article-left', 'count', 'review-serving-summary:v1', '${countContributionKey}', 1),
          ('rebuild-summary-1', 'chunk-left', 'project-1', 'review-config-1', 'snapshot-1', 'article-boundary', 'count', 'review-serving-summary:v1', '${countContributionKey}', 1),
          ('rebuild-summary-1', 'chunk-right', 'project-1', 'review-config-1', 'snapshot-1', 'article-boundary', 'count', 'review-serving-summary:v1', '${countContributionKey}', 1),
          ('rebuild-summary-1', 'chunk-right', 'project-1', 'review-config-1', 'snapshot-1', 'article-right', 'count', 'review-serving-summary:v1', '${countContributionKey}', 1),
          ('rebuild-summary-1', 'chunk-left', 'project-1', 'review-config-1', 'snapshot-1', 'article-left', 'count', 'review-serving-summary:v1', '${facetContributionKey}', 1),
          ('rebuild-summary-1', 'chunk-left', 'project-1', 'review-config-1', 'snapshot-1', 'article-boundary', 'count', 'review-serving-summary:v1', '${facetContributionKey}', 1),
          ('rebuild-summary-1', 'chunk-right', 'project-1', 'review-config-1', 'snapshot-1', 'article-boundary', 'count', 'review-serving-summary:v1', '${facetContributionKey}', 1),
          ('rebuild-summary-1', 'chunk-right', 'project-1', 'review-config-1', 'snapshot-1', 'article-right', 'count', 'review-serving-summary:v1', '${facetContributionKey}', 1)
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
      const facetRows = await database.queryJson<{countValue: string}>(`
        SELECT CAST(count_value AS VARCHAR) AS countValue
        FROM mart.review_filter_facet_serving_v4
      `)

      expect(countRows).toEqual([{countValue: '3'}])
      expect(facetRows).toEqual([{countValue: '3'}])
    } finally {
      close()
    }
  } finally {
    removeFileIfExists(duckdbPath)
  }
})

test('summary rebuild request finalization retries from retained contribution partials without main contribution state', async () => {
  const duckdbPath = `/tmp/forska-summary-retained-contribution-finalize-${Date.now()}.duckdb`
  const countContributionKey = contributionKey({
    answerId: null,
    answerValue: null,
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
  })

  try {
    const {close, database} = await createDuckdbSummaryDatabase(duckdbPath)

    try {
      await createSummaryReductionSchema(database)
      await insertSummaryChunkManifestRows(database, {chunkIds: ['chunk-left', 'chunk-right']})
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
          ('rebuild-summary-1', 'chunk-left', 'project-1', 'review-config-1', 'snapshot-1', 'count-key', 'count', 'review.llm.assessedByPrompt', 'llm', 'review.llm.assessedByPrompt', 'review-llm-assessed-by-prompt:v1', 'prompt:prompt-1', 2),
          ('rebuild-summary-1', 'chunk-right', 'project-1', 'review-config-1', 'snapshot-1', 'count-key', 'count', 'review.llm.assessedByPrompt', 'llm', 'review.llm.assessedByPrompt', 'review-llm-assessed-by-prompt:v1', 'prompt:prompt-1', 2)
      `)
      await database.run(`
        INSERT INTO mart.review_article_summary_contribution_rebuild_partial_v4 (
          request_id,
          chunk_id,
          project_id,
          review_config_hash,
          snapshot_id,
          article_id,
          component_kind,
          summary_definition_version,
          contribution_key,
          contribution_value
        ) VALUES
          ('rebuild-summary-1', 'chunk-left', 'project-1', 'review-config-1', 'snapshot-1', 'article-left', 'count', 'review-serving-summary:v1', '${countContributionKey}', 1),
          ('rebuild-summary-1', 'chunk-left', 'project-1', 'review-config-1', 'snapshot-1', 'article-boundary', 'count', 'review-serving-summary:v1', '${countContributionKey}', 1),
          ('rebuild-summary-1', 'chunk-right', 'project-1', 'review-config-1', 'snapshot-1', 'article-boundary', 'count', 'review-serving-summary:v1', '${countContributionKey}', 1),
          ('rebuild-summary-1', 'chunk-right', 'project-1', 'review-config-1', 'snapshot-1', 'article-right', 'count', 'review-serving-summary:v1', '${countContributionKey}', 1)
      `)

      await reduceReviewServingSummaryRebuildPartialsForRequestSnapshots(
        {
          requestId: 'rebuild-summary-1',
          snapshots: [{projectId: 'project-1', reviewConfigHash: 'review-config-1', snapshotId: 'snapshot-1'}],
        },
        database,
      )
      await database.run(`
        DELETE FROM mart.review_article_count_serving_v4
        WHERE project_id = 'project-1'
      `)

      await reduceReviewServingSummaryRebuildPartialsForRequestSnapshots(
        {
          requestId: 'rebuild-summary-1',
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
      const countRows = await database.queryJson<{countValue: string}>(`
        SELECT CAST(count_value AS VARCHAR) AS countValue
        FROM mart.review_article_count_serving_v4
      `)
      const retainedContributionRows = await database.queryJson<{total: string}>(`
        SELECT CAST(COUNT(*) AS VARCHAR) AS total
        FROM mart.review_article_summary_contribution_rebuild_partial_v4
      `)

      expect(countRows).toEqual([{countValue: '3'}])
      expect(retainedContributionRows).toEqual([{total: '4'}])
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
      await insertSummaryChunkManifestRows(database, {chunkIds: ['chunk-001']})
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
      await insertSummaryChunkManifestRows(database, {chunkIds: ['chunk-001']})
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

  expect(sourceStatement).toContain('serving.publication_year')
  expect(sourceStatement).not.toContain('selected_patch.publication_year')
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

test('direct summary recompute aggregates shared count keys before writing', async () => {
  const {database} = createSummaryDatabase({
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
  expect(hasSummaryValue(result.summaryValues, {count_kind: 'review.queue.unassessedReady', count_value: 2})).toBe(true)
})

test('prompt badge counts flow through direct summary recompute used by review.prompt.badges', async () => {
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
  expect(joined).not.toContain('mart.review_article_summary_contribution_v4')
})

test('summary status and answer sources require selected scope', async () => {
  const {database, statements} = createSummaryDatabase()

  await projectReviewServingSummaries(projectInput([summaryClaim()]), database)

  const sourceStatement = statements.find((statement) => {
    return statement.includes('FROM summary_union')
  })

  expect(sourceStatement).toContain('INNER JOIN selected_article selected ON selected.article_id = llm.article_id')
  expect(sourceStatement).toContain('INNER JOIN selected_article selected ON selected.article_id = queue.article_id')
  expect(sourceStatement).toContain('INNER JOIN selected_article selected ON selected.article_id = human.article_id')
})

test('summary recompute ignores unsupported legacy contribution state', async () => {
  const {database, statements} = createSummaryDatabase({sourceRows: [sourceCountRow()]})

  const result = await projectReviewServingSummaries(projectInput([summaryClaim()]), database)
  const joined = statements.join('\n')

  expect(result.repairRequired).toBe(false)
  expect(result.summaryRowCount).toBe(1)
  expect(joined).not.toContain('review-serving-contribution-repair')
  expect(joined).not.toContain('mart.review_article_summary_contribution_v4')
})

test('deferred summary option phases do not publish manifests or watermarks', async () => {
  const {database, statements} = createSummaryDatabase({sourceRows: [sourceCountRow()]})

  await projectReviewServingSummaries({...projectInput([summaryClaim()]), acknowledgeClaims: false}, database)
  const joined = statements.join('\n')

  expect(joined).not.toContain('INSERT INTO app.review_serving_projection_manifest')
  expect(joined).not.toContain('INSERT INTO app.review_serving_projector_watermark')
})
