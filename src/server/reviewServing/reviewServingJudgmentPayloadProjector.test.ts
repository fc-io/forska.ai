import {expect, test} from 'bun:test'

import {type ReviewServingDirtyWorkClaim} from './reviewServingDirtyWorkService.ts'
import {
  projectReviewServingJudgmentPayloadRows,
  type ReviewServingJudgmentPayloadProjectorDatabase,
} from './reviewServingJudgmentPayloadProjector.ts'
import {getReviewServingReadContract} from './reviewServingReadContracts.ts'
import {buildReviewServingRowsSql} from './reviewServingSql.ts'

const judgmentClaim = (input?: Partial<ReviewServingDirtyWorkClaim>): ReviewServingDirtyWorkClaim => {
  return {
    articleId: 'article-1',
    dirtyKind: 'judgment.llm.updated',
    dirtyRangeEnd: null,
    dirtyRangeStart: null,
    dirtyWorkId: 'dirty-work-1',
    firstSourceHighWaterMark: 4,
    latestDeltaId: 'delta-1',
    latestSourceHighWaterMark: 6,
    projectId: 'project-1',
    projectionComponent: 'payload',
    projectionIdentity: 'payload:identity-1',
    scopeId: 'project-1:article-1',
    scopeKind: 'article',
    sourcePartition: 'review-change:judgment',
    status: 'running',
    ...input,
  }
}

const createJudgmentPayloadDatabase = (input?: {humanCount?: number; llmCount?: number}) => {
  const statements: string[] = []
  const database: ReviewServingJudgmentPayloadProjectorDatabase = {
    queryJson: async <T>(statement: string) => {
      statements.push(statement)

      if (statement.includes('COUNT(*)') && statement.includes("payload_kind = 'llm'")) {
        return [{rowCount: input?.llmCount ?? 0}] as T[]
      }

      if (statement.includes('COUNT(*)') && statement.includes("payload_kind = 'human'")) {
        return [{rowCount: input?.humanCount ?? 0}] as T[]
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

const projectInput = (claims: readonly ReviewServingDirtyWorkClaim[] = []) => {
  return {
    claims,
    listModeKeys: ['llm', 'human', 'both'] as const,
    modelId: 'model-1',
    projectId: 'project-1',
    reviewConfigHash: 'review-config-1',
    snapshotId: 'snapshot-1',
    useAbstract: true,
    useFulltext: false,
    useFulltextNoImages: false,
    useTitle: true,
  }
}

const claimedProjectInput = (claims: readonly ReviewServingDirtyWorkClaim[] = []) => {
  return {
    ...projectInput(claims),
    baseGeneration: 1,
    definitionVersion: 'payload-v4-test',
    projectionIdentity: 'payload:identity-1',
  }
}

test('judgment payload projection writes llm and human payload kinds with SQL-native statements', async () => {
  const {database, statements} = createJudgmentPayloadDatabase({humanCount: 4, llmCount: 4})

  const result = await projectReviewServingJudgmentPayloadRows(projectInput([judgmentClaim()]), database)
  const joined = statements.join('\n')
  const inserts = statements.filter((statement) => {
    return statement.includes('INSERT INTO mart.review_article_judgment_detail_serving_v4')
  })

  expect(result).toMatchObject({
    diagnosticsJson: {
      judgmentPayloadProjector: {
        directSqlWriter: true,
        humanMaterializedRecordCount: 0,
        humanSourceRowCount: 0,
        llmMaterializedRecordCount: 0,
        llmSourceRowCount: 0,
        materializedRecordCount: 0,
      },
    },
    humanRowCount: 4,
    llmRowCount: 4,
  })
  expect(result.diagnosticsJson.phaseTimings.writerMs).toBeGreaterThanOrEqual(0)
  expect(result.diagnosticsJson.phaseTimings.postWriteCountMs).toBeGreaterThanOrEqual(0)
  expect(result.diagnosticsJson.phaseTimings.recordTransformMs).toBeUndefined()
  expect(result.diagnosticsJson.phaseTimings.sourceQueryMs).toBeUndefined()
  expect(result.diagnosticsJson.judgmentPayloadProjector.writer.records.inputRecordCount).toBe(0)
  expect(inserts).toHaveLength(2)
  expect(inserts.join('\n')).toContain(
    'ON CONFLICT(project_id, review_config_hash, snapshot_id, list_mode_key, payload_kind, article_id, prompt_id) DO UPDATE SET',
  )
  expect(joined).toContain("'llm'")
  expect(joined).toContain("'human'")
  expect(joined).toContain("'both'")
  expect(joined).toContain("'summary'")
  expect(joined).toContain("'llm.unanswered'")
  expect(joined).toContain('payloadReference')
  expect(joined).toContain('human_summary')
})

test('judgment payload projection replaces only dirty article detail rows', async () => {
  const {database, statements} = createJudgmentPayloadDatabase()

  await projectReviewServingJudgmentPayloadRows(projectInput([judgmentClaim()]), database)
  const llmInsert = statements.find((statement) => {
    return statement.includes('latest_judgment AS') && statement.includes("'llm' AS payload_kind")
  })
  const deleteStatements = statements.filter((statement) => {
    return statement.includes('DELETE FROM mart.review_article_judgment_detail_serving_v4')
  })
  const llmDeleteStatement = deleteStatements.find((statement) => {
    return statement.includes("payload_kind IS NOT DISTINCT FROM 'llm'")
  })
  const humanDeleteStatement = deleteStatements.find((statement) => {
    return statement.includes("payload_kind IS NOT DISTINCT FROM 'human'")
  })

  expect(llmInsert).toContain("VALUES ('article-1')")
  expect(llmInsert).toContain('COALESCE(prompt.archived, FALSE) = FALSE')
  expect(llmInsert).toContain('ORDER BY judgment.created_at DESC NULLS LAST, judgment.id DESC')
  expect(llmInsert).toContain('prompt.original_text AS prompt_original_text')
  expect(llmInsert).toContain('provider_connection.provider_kind AS model_provider')
  expect(llmInsert).toContain("json_extract_string(model.metadata_json, '$.options.thinking') AS model_thinking")
  expect(llmInsert).toContain('INNER JOIN article_id_filter dirty ON dirty.article_id = scope.article_id')
  expect(llmDeleteStatement).toContain("article_id IN ('article-1')")
  expect(llmDeleteStatement).toContain("list_mode_key IS NOT DISTINCT FROM 'llm'")
  expect(humanDeleteStatement).toContain("article_id IN ('article-1')")
  expect(humanDeleteStatement).toContain("list_mode_key IS NOT DISTINCT FROM 'human'")
  expect(statements.join('\n')).toContain('INSERT INTO app.review_serving_dirty_work_ack')
})

test('human payload projection filters rows by active human judgment mode', async () => {
  const {database, statements} = createJudgmentPayloadDatabase()

  await projectReviewServingJudgmentPayloadRows(projectInput([judgmentClaim()]), database)
  const humanSelect = statements.find((statement) => {
    return statement.includes('FROM active_article active') && statement.includes('judgment_human_summary')
  })

  expect(humanSelect).toContain("COALESCE(project.human_judgment_mode, 'prompt') = 'prompt'")
  expect(humanSelect).toContain("COALESCE(project.human_judgment_mode, 'prompt') = 'summary'")
})

test('judgment payload projection replaces broad project detail rows', async () => {
  const {database, statements} = createJudgmentPayloadDatabase()

  await projectReviewServingJudgmentPayloadRows(
    projectInput([
      judgmentClaim({
        articleId: null,
        dirtyKind: 'project.reviewConfig.updated',
        scopeId: 'project-1',
        scopeKind: 'project',
      }),
    ]),
    database,
  )
  const deleteStatements = statements.filter((statement) => {
    return statement.includes('DELETE FROM mart.review_article_judgment_detail_serving_v4')
  })

  expect(deleteStatements.length).toBeGreaterThan(0)
  expect(deleteStatements[0]).not.toContain('article_id IN')
  expect(deleteStatements[0]).toContain("project_id IS NOT DISTINCT FROM 'project-1'")
  expect(deleteStatements[0]).toContain("review_config_hash IS NOT DISTINCT FROM 'review-config-1'")
})

test('judgment payload projection writes payload manifest when acknowledging claims', async () => {
  const {database, statements} = createJudgmentPayloadDatabase()

  await projectReviewServingJudgmentPayloadRows(claimedProjectInput([judgmentClaim()]), database)
  const joined = statements.join('\n')

  expect(joined).toContain('INSERT INTO app.review_projection_identity_manifest')
  expect(joined).toContain('INSERT INTO app.review_serving_projector_watermark')
  expect(joined).toContain('review-serving-judgment-payload-projector')
  expect(joined).toContain('INSERT INTO app.review_serving_dirty_work_ack')
})

test('claimless article-range judgment payload rebuild writes detail rows with SQL-native statements', async () => {
  const {database, statements} = createJudgmentPayloadDatabase({humanCount: 4, llmCount: 4})

  const result = await projectReviewServingJudgmentPayloadRows(
    {...projectInput(), chunkEndArticleId: 'article-9', chunkStartArticleId: 'article-1'},
    database,
  )
  const joined = statements.join('\n')
  const sourceQueries = statements.filter((statement) => {
    return statement.includes('FROM active_article active') && !statement.includes('INSERT INTO')
  })
  const inserts = statements.filter((statement) => {
    return statement.includes('INSERT INTO mart.review_article_judgment_detail_serving_v4')
  })

  expect(result).toMatchObject({
    diagnosticsJson: {
      judgmentPayloadProjector: {
        directSqlWriter: true,
        humanMaterializedRecordCount: 0,
        llmMaterializedRecordCount: 0,
        materializedRecordCount: 0,
      },
    },
    humanRowCount: 4,
    llmRowCount: 4,
  })
  expect(result.diagnosticsJson.phaseTimings.recordTransformMs).toBeUndefined()
  expect(result.diagnosticsJson.phaseTimings.sourceQueryMs).toBeUndefined()
  expect(result.diagnosticsJson.phaseTimings.writerMs).toBeGreaterThanOrEqual(0)
  expect(result.diagnosticsJson.phaseTimings.postWriteCountMs).toBeGreaterThanOrEqual(0)
  expect(result.diagnosticsJson.judgmentPayloadProjector.writer.records.inputRecordCount).toBe(0)
  expect(inserts).toHaveLength(2)
  expect(sourceQueries).toHaveLength(0)
  expect(joined).toContain("article_id >= 'article-1'")
  expect(joined).toContain("article_id <= 'article-9'")
  expect(joined).toContain("list_mode(list_mode_key) AS (SELECT * FROM (VALUES ('llm'), ('both')))")
  expect(joined).toContain("list_mode(list_mode_key) AS (SELECT * FROM (VALUES ('human'), ('both')))")
  expect(joined).toContain('json_object(')
  expect(joined).toContain(
    'ON CONFLICT(project_id, review_config_hash, snapshot_id, list_mode_key, payload_kind, article_id, prompt_id) DO UPDATE SET',
  )
})

test('article-set judgment hydration reads bounded payload rows with stable ordering', () => {
  const contract = getReviewServingReadContract('review.both.list.humanJudgments')

  if (contract === null) {
    throw new Error('expected review.both.list.humanJudgments contract')
  }

  const sql = buildReviewServingRowsSql({
    articleIdsParameter: '$articleIds',
    contract,
    displayIdentityParameter: '$displayIdentity',
    limitParameter: '$limit',
    listModeParameter: '$listMode',
    payloadIdentityParameter: '$payloadIdentity',
    projectIdParameter: '$projectId',
    projectScopeIdentityParameter: '$projectScopeIdentity',
    reviewConfigHashParameter: '$reviewConfigHash',
    searchIdentityParameter: '$searchIdentity',
    snapshotIdParameter: '$snapshotId',
  })

  expect(sql).toContain('FROM mart.review_article_judgment_detail_serving_v4')
  expect(sql).toContain('article_id IN (SELECT unnest($articleIds))')
  expect(sql).toContain("AND list_mode_key = 'both'")
  expect(sql).toContain("AND payload_kind = 'human'")
  expect(sql).toContain('ORDER BY article_id ASC, prompt_order ASC NULLS LAST, prompt_id ASC')
  expect(sql).toContain('LIMIT $limit')
})
