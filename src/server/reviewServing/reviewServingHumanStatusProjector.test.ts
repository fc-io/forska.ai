import {DuckDBInstance} from '@duckdb/node-api'
import {expect, test} from 'bun:test'

import {decodeReviewServingJsonRows} from '../test/decodeReviewServingJsonRows.ts'
import {duckdbEngineCompatibilityOptions} from '../utils/duckdbEngineContract.ts'
import {type ReviewServingDirtyWorkClaim} from './reviewServingDirtyWorkService.ts'
import {
  projectReviewServingHumanStatusPatches,
  projectReviewServingHumanStatusRanges,
  type ReviewServingHumanStatusProjectorDatabase,
} from './reviewServingHumanStatusProjector.ts'
import {
  getReviewServingProjectPromptConfigRows,
  getReviewServingProjectReviewSettings,
  getReviewServingReviewConfigHash,
  type ReviewServingProjectReviewSettingsRow,
} from './reviewServingReviewConfig.ts'

const createHumanStatusDatabase = (input?: {
  judgmentRows?: readonly Record<string, unknown>[]
  promptConfigRows?: readonly Record<string, unknown>[]
  promptRows?: readonly Record<string, unknown>[]
  projectRows?: readonly Record<string, unknown>[]
  projectSettingsRows?: readonly Record<string, unknown>[]
}) => {
  const statements: string[] = []
  const database: ReviewServingHumanStatusProjectorDatabase = {
    queryJson: async <T>(statement: string) => {
      statements.push(statement)

      if (statement.includes('FROM app.review_source_change_outbox')) {
        return [] as T[]
      }

      if (statement.includes('FROM app.project_prompt project_prompt')) {
        return (input?.promptConfigRows ?? [promptConfigRow()]) as T[]
      }

      if (statement.includes('FROM app.project project')) {
        return (input?.projectSettingsRows ?? [projectSettingsRow()]) as T[]
      }

      if (statement.includes('FROM app.review_change_delta delta')) {
        return (input?.judgmentRows ?? []) as T[]
      }

      if (statement.includes('FROM prompt_id_filter dirty_prompt')) {
        return (input?.promptRows ?? []) as T[]
      }

      if (statement.includes('FROM mart.project_scope_article scope')) {
        return (input?.projectRows ?? []) as T[]
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

const promptConfigRow = (input?: Record<string, unknown>) => {
  return {
    answerSchemaHash: null,
    promptId: 'prompt-1',
    promptOrder: 1,
    promptTextHash: 'prompt-text-1',
    settingsVersion: 'prompt-v1',
    thresholdVersion: null,
    ...input,
  }
}

const projectSettingsRow = (
  input?: Partial<ReviewServingProjectReviewSettingsRow>,
): ReviewServingProjectReviewSettingsRow => {
  return {
    fullTextStrategyId: 'fts-none',
    humanJudgmentMode: 'prompt',
    modelExecutionOptions: '{"thinking":{"effort":"medium"}}',
    modelId: 'model-1',
    modelProviderBaseUrl: 'https://provider.example',
    modelProviderConnectionId: 'provider-1',
    modelProviderKind: 'openai-compatible',
    modelRemoteModelId: 'remote-model-1',
    modelVariant: 'thinking',
    systemPromptVariant: 'legacy',
    useAbstract: true,
    useFulltext: false,
    useFulltextNoImages: false,
    useMetadata: false,
    useTitle: true,
    ...input,
  }
}

const humanStatusRow = (input?: Record<string, unknown>) => {
  return {
    answerSchemaHash: null,
    articleId: 'article-1',
    humanAnsweredValue: 'yes',
    humanStatusKey: 'answered',
    latestHumanUpdatedAt: '2026-06-16T10:00:00.000Z',
    payloadJson: null,
    promptId: 'prompt-1',
    promptOrSummaryKey: 'prompt-1',
    promptOrder: 1,
    promptTextHash: 'prompt-text-1',
    settingsVersion: 'prompt-v1',
    sourceOperation: 'update',
    thresholdVersion: null,
    tombstone: false,
    ...input,
  }
}

const humanClaim = (input?: Partial<ReviewServingDirtyWorkClaim>): ReviewServingDirtyWorkClaim => {
  return {
    articleId: 'article-1',
    dirtyKind: 'judgment.human.updated',
    dirtyRangeEnd: null,
    dirtyRangeStart: null,
    dirtyWorkId: 'dirty-work-1',
    firstSourceHighWaterMark: 12,
    latestDeltaId: 'delta-1',
    latestSourceHighWaterMark: 14,
    projectId: 'project-1',
    projectionComponent: 'humanStatus',
    projectionIdentity: 'humanStatus:identity-1',
    scopeId: 'project-1:article-1',
    scopeKind: 'article',
    sourcePartition: 'humanJudgment:project-1:article-1',
    status: 'running',
    ...input,
  }
}

const projectInput = (claims: readonly ReviewServingDirtyWorkClaim[]) => {
  return {
    baseGeneration: 5,
    claims,
    definitionVersion: 'human-status-v4-test',
    listModeKeys: ['human'],
    projectId: 'project-1',
    projectionIdentity: 'humanStatus:identity-1',
  }
}

test('human prompt answer deltas update serving directly', async () => {
  const {database, statements} = createHumanStatusDatabase({judgmentRows: [humanStatusRow()]})

  const result = await projectReviewServingHumanStatusPatches(projectInput([humanClaim()]), database)
  const selectStatement = statements.find((statement) => {
    return statement.includes('FROM app.review_change_delta delta')
  })
  const joined = statements.join('\n')

  expect(result).toEqual({patchRowCount: 0, patchWatermark: 14})
  expect(selectStatement).toContain('LEFT JOIN app."judgment_human" judgment_human')
  expect(selectStatement).toContain('LEFT JOIN app."judgment_human_summary" judgment_human_summary')
  expect(selectStatement).toContain("VALUES ('article-1')")
  expect(joined).not.toContain('mart.review_human_status_patch_v4')
  expect(joined).toContain('UPDATE mart.review_article_serving_list_mode_state_v4 state')
  expect(joined).toContain('review_config_hash')
  expect(joined).toContain('state.review_config_hash IS NOT DISTINCT FROM article_status.review_config_hash')
  expect(joined).toContain('human_status = article_status.human_status')
  expect(joined).toContain("prompt_id <> 'summary'")
  expect(joined).not.toContain('human_answered_prompt_count =')
  expect(joined).not.toContain('human_status_key = CASE')
  expect(joined).not.toContain('serving.enabled_prompt_count')
  expect(joined).toContain("'humanStatus'")
  expect(joined).not.toContain('scope.source_updated_at')
  expect(joined).not.toContain("'llmStatus'")
  expect(joined).not.toContain("'selectedImport'")
})

test('human-status no-ack snapshot passes do not publish shared manifests or watermarks', async () => {
  const {database, statements} = createHumanStatusDatabase({judgmentRows: []})

  await projectReviewServingHumanStatusPatches({...projectInput([humanClaim()]), acknowledgeClaims: false}, database)
  const joined = statements.join('\n')

  expect(joined).not.toContain('INSERT INTO app.review_projection_identity_manifest')
  expect(joined).not.toContain('INSERT INTO app.review_serving_projector_watermark')
  expect(joined).not.toContain("SET status = 'completed', lifecycle_reason = 'projected'")
})

test('human status review config hash includes model execution identity', async () => {
  const promptRows = [promptConfigRow()]
  const projectRows = [projectSettingsRow()]
  const expectedHash = getReviewServingReviewConfigHash({...projectSettingsRow(), promptConfigRows: promptRows})
  const {database, statements} = createHumanStatusDatabase({
    judgmentRows: [humanStatusRow()],
    projectSettingsRows: projectRows,
    promptConfigRows: promptRows,
  })

  await projectReviewServingHumanStatusPatches(projectInput([humanClaim()]), database)

  expect(statements.join('\n')).toContain(expectedHash)
})

test('summary human answers do not require prompt IDs and update summary-key serving state', async () => {
  const {database, statements} = createHumanStatusDatabase({
    judgmentRows: [humanStatusRow({promptId: null, promptOrSummaryKey: 'summary'})],
    projectSettingsRows: [projectSettingsRow({humanJudgmentMode: 'summary'})],
  })

  const result = await projectReviewServingHumanStatusPatches(projectInput([humanClaim()]), database)
  const joined = statements.join('\n')

  expect(result).toEqual({patchRowCount: 0, patchWatermark: 14})
  expect(joined).not.toContain('mart.review_human_status_patch_v4')
  expect(
    decodeReviewServingJsonRows(joined).map((row) => {
      return [row.prompt_id, row.human_status_key, row.tombstone]
    }),
  ).toContainEqual(['summary', 'answered', 'false'])
  expect(joined).toContain("'humanStatus'")
  expect(joined).toContain("SET status = 'completed', lifecycle_reason = 'projected'")
  expect(joined).toContain('INSERT INTO app.review_serving_projector_watermark')
  expect(joined).toContain('WHERE NOT EXISTS')
  expect(joined).not.toContain("'llmStatus'")
})

test('Covidence summary placeholders with null answers remain human-unanswered', async () => {
  const {database, statements} = createHumanStatusDatabase({
    judgmentRows: [
      humanStatusRow({
        humanAnsweredValue: null,
        promptId: null,
        promptOrSummaryKey: 'summary',
        summaryOrigin: 'covidence_import',
      }),
    ],
    projectSettingsRows: [projectSettingsRow({humanJudgmentMode: 'summary'})],
  })

  const result = await projectReviewServingHumanStatusPatches(projectInput([humanClaim()]), database)
  const joined = statements.join('\n')

  expect(result).toEqual({patchRowCount: 0, patchWatermark: 14})
  expect(joined).not.toContain('mart.review_human_status_patch_v4')
  expect(
    decodeReviewServingJsonRows(joined).map((row) => {
      return [row.prompt_id, row.human_status_key, row.tombstone]
    }),
  ).toContainEqual(['summary', 'unanswered', 'false'])
})

test('human prompt and summary answer changes use delta payload values as contribution inputs', async () => {
  const {database, statements} = createHumanStatusDatabase({
    judgmentRows: [
      humanStatusRow({humanAnsweredValue: 'latest', payloadJson: {answer: 'old-prompt'}}),
      humanStatusRow({
        articleId: 'article-2',
        humanAnsweredValue: 'latest',
        payloadJson: '{"answer":"new-summary"}',
        promptId: null,
        promptOrSummaryKey: 'summary',
      }),
    ],
  })

  const result = await projectReviewServingHumanStatusPatches(projectInput([humanClaim()]), database)

  expect(result).toEqual({patchRowCount: 0, patchWatermark: 14})
  expect(statements.join('\n')).not.toContain('mart.review_human_status_patch_v4')
})

test('human answer deletes update serving directly and acknowledge idempotently', async () => {
  const {database, statements} = createHumanStatusDatabase({
    judgmentRows: [humanStatusRow({humanAnsweredValue: null, humanStatusKey: null, tombstone: true})],
  })

  await projectReviewServingHumanStatusPatches(
    projectInput([humanClaim({dirtyKind: 'judgment.human.updated'})]),
    database,
  )
  await projectReviewServingHumanStatusPatches(
    projectInput([humanClaim({dirtyKind: 'judgment.human.updated'})]),
    database,
  )

  expect(statements.join('\n')).not.toContain('mart.review_human_status_patch_v4')
})

test('prompt config claims rebuild only prompt-scoped human status rows', async () => {
  const {database, statements} = createHumanStatusDatabase({promptRows: [humanStatusRow({articleId: 'article-2'})]})

  const result = await projectReviewServingHumanStatusPatches(
    projectInput([
      humanClaim({
        articleId: null,
        dirtyKind: 'prompt.config.updated',
        scopeId: 'project-1:prompt-1',
        scopeKind: 'prompt',
      }),
    ]),
    database,
  )
  const promptSelect = statements.find((statement) => {
    return statement.includes('FROM prompt_id_filter dirty_prompt')
  })
  const deltaSelect = statements.find((statement) => {
    return statement.includes('FROM app.review_change_delta delta')
  })

  expect(result).toEqual({patchRowCount: 0, patchWatermark: 14})
  expect(promptSelect).toContain("VALUES ('prompt-1')")
  expect(promptSelect).toContain('INNER JOIN mart.project_scope_article scope')
  expect(promptSelect).toContain('LEFT JOIN app."judgment_human" judgment_human')
  expect(promptSelect).toContain('judgment_human.prompt_id = dirty_prompt.prompt_id')
  expect(promptSelect).toContain('project_prompt.prompt_id IS NULL AS tombstone')
  expect(promptSelect).toContain('LEFT JOIN app.project_prompt project_prompt')
  expect(promptSelect).toContain('project_prompt.enabled = TRUE')
  expect(promptSelect).toContain('COALESCE(prompt.archived, FALSE) = FALSE')
  expect(promptSelect).not.toContain('scope.source_updated_at')
  expect(deltaSelect).toBeUndefined()
})

test('human rebuild chunks copy-replace serving without scoped patch rows', async () => {
  const {database, statements} = createHumanStatusDatabase({projectRows: [humanStatusRow({articleId: 'article-3'})]})

  const result = await projectReviewServingHumanStatusPatches(
    {...projectInput([]), chunkEndArticleId: 'article-3', chunkStartArticleId: 'article-3'},
    database,
  )
  const joined = statements.join('\n')

  expect(result).toEqual({patchRowCount: 0, patchWatermark: 0})
  expect(joined).not.toContain('mart.review_human_status_patch_v4')
  expect(joined).toContain('UPDATE mart.review_article_serving_list_mode_state_v4 state')
  expect(joined).toContain('WITH article_range_filter(chunk_start_article_id, chunk_end_article_id) AS')
  expect(joined).toContain("('article-3', 'article-3')")
  expect(joined).toContain('INNER JOIN article_range_filter range')
  expect(joined).toContain('serving.article_id >= range.chunk_start_article_id')
  expect(joined).toContain('serving.article_id <= range.chunk_end_article_id')
  expect(joined).toContain('SET human_status = article_status.human_status')
  expect(joined).toContain('human_patch_watermark =')
  expect(joined).toContain("json_each(json_extract(snapshot.component_state_json, '$.required'))")
  expect(joined).toContain("json_each(json_extract(snapshot.component_state_json, '$.optional'))")
  expect(joined).toContain("json_extract_string(component_state.value, '$.component') = 'humanStatus'")
  expect(joined).toContain(
    "json_extract_string(component_state.value, '$.projectionIdentity') = 'humanStatus:identity-1'",
  )
  expect(joined).not.toContain(
    "json_extract_string(snapshot.composed_identity_json, '$.humanStatus.projectionIdentity')",
  )
  expect(joined).not.toContain('replacement.human_status_identity = serving.human_status_identity')
  expect(joined).toContain('serving.base_generation = 5')
})

test('human direct full rebuild chunks copy-replace serving without patch rows', async () => {
  const {database, statements} = createHumanStatusDatabase({projectRows: [humanStatusRow({articleId: 'article-3'})]})

  const result = await projectReviewServingHumanStatusPatches(
    {...projectInput([]), chunkEndArticleId: 'article-3', chunkStartArticleId: 'article-3', emitPatchRows: false},
    database,
  )
  const joined = statements.join('\n')

  expect(result).toEqual({patchRowCount: 0, patchWatermark: 0})
  expect(joined).not.toContain('DELETE FROM mart.review_human_status_patch_v4')
  expect(joined).not.toContain('INSERT INTO mart.review_human_status_patch_v4')
  expect(joined).not.toContain('FROM mart.review_human_status_patch_v4')
  expect(joined).toContain('UPDATE mart.review_article_serving_list_mode_state_v4 state')
  expect(joined).toContain("json_each(json_extract(snapshot.component_state_json, '$.required'))")
  expect(joined).toContain("json_each(json_extract(snapshot.component_state_json, '$.optional'))")
  expect(joined).toContain("json_extract_string(component_state.value, '$.component') = 'humanStatus'")
  expect(joined).toContain(
    "json_extract_string(component_state.value, '$.projectionIdentity') = 'humanStatus:identity-1'",
  )
  expect(joined).not.toContain(
    "json_extract_string(snapshot.composed_identity_json, '$.humanStatus.projectionIdentity')",
  )
  expect(joined).not.toContain('replacement.human_status_identity = serving.human_status_identity')
  expect(joined).toContain('serving.base_generation = 5')
})

test('human rebuild chunks avoid patch delete and insert batches', async () => {
  const {database, statements} = createHumanStatusDatabase({
    projectRows: Array.from({length: 251}, (_, index) => {
      return humanStatusRow({articleId: `article-${String(index).padStart(3, '0')}`})
    }),
  })

  const result = await projectReviewServingHumanStatusPatches(
    {...projectInput([]), chunkEndArticleId: 'article-250', chunkStartArticleId: 'article-000'},
    database,
  )
  expect(result).toEqual({patchRowCount: 0, patchWatermark: 0})
  expect(statements.join('\n')).not.toContain('mart.review_human_status_patch_v4')
})

test('human range rebuild batches write one SQL-native serving replacement statement', async () => {
  const {database, statements} = createHumanStatusDatabase()

  const result = await projectReviewServingHumanStatusRanges(
    {
      ranges: [
        {...projectInput([]), chunkEndArticleId: 'article-050', chunkStartArticleId: 'article-001'},
        {...projectInput([]), chunkEndArticleId: 'article-099', chunkStartArticleId: 'article-051'},
      ],
    },
    database,
  )
  const replacementStatements = statements.filter((statement) => {
    return statement.includes('UPDATE mart.review_article_serving_list_mode_state_v4 state')
  })
  const joined = statements.join('\n')
  const diagnostics = result as typeof result & {
    diagnosticsJson: {humanStatusProjector: {fullRebuildMode: string; rangeCount: number; sourceRowCount: number}}
  }

  expect(result).toEqual({patchRowCount: 0, patchWatermark: 0})
  expect(diagnostics.diagnosticsJson.humanStatusProjector).toMatchObject({
    fullRebuildMode: 'range-serving-set-based',
    rangeCount: 2,
    sourceRowCount: 0,
  })
  expect(replacementStatements).toHaveLength(1)
  expect(replacementStatements[0]).toContain('article_range_filter(chunk_start_article_id, chunk_end_article_id)')
  expect(replacementStatements[0]).toContain("('article-001', 'article-050'), ('article-051', 'article-099')")
  expect(joined).toContain('FROM app.project_prompt project_prompt')
  expect(joined).toContain('LEFT JOIN app."judgment_human" judgment_human')
  expect(joined).toContain('human_status = article_status.human_status')
  expect(joined).toContain("BOOL_OR(NULLIF(TRIM(COALESCE(judgment_human_summary.answer, '')), '') IS NOT NULL)")
})
test('human judgment delta lookup matches claim watermark ranges through one claim range table for any batch size', async () => {
  const {database, statements} = createHumanStatusDatabase()
  const claims = Array.from({length: 1_500}, (_, index) => {
    return humanClaim({
      articleId: `article-${index}`,
      dirtyWorkId: `dirty-work-${index}`,
      firstSourceHighWaterMark: index + 1,
      latestSourceHighWaterMark: index + 2,
      sourcePartition: 'import-route:route-1',
    })
  })

  await projectReviewServingHumanStatusPatches(projectInput(claims), database)

  const selectStatement =
    statements.find((statement) => {
      return statement.includes('FROM app.review_change_delta delta')
    }) ?? ''

  expect(selectStatement).toContain(
    'claim_range(source_partition, first_source_high_water_mark, latest_source_high_water_mark)',
  )
  expect(selectStatement).toContain("('import-route:route-1', 1500, 1501)")
  expect(selectStatement).not.toContain('OR (delta.source_partition')
})

type DuckdbConnection = Awaited<ReturnType<Awaited<ReturnType<typeof DuckDBInstance.create>>['connect']>>

const duckdbProjectId = 'project-1'
const duckdbSnapshotId = 'snapshot-1'
const duckdbProjectionIdentity = 'humanStatus:identity-1'

const getDuckdbHumanStatusDatabase = (
  connection: DuckdbConnection,
  options?: {skipArticleScopedRead?: boolean},
): ReviewServingHumanStatusProjectorDatabase => {
  const database: ReviewServingHumanStatusProjectorDatabase = {
    queryJson: async <T>(statement: string) => {
      if (options?.skipArticleScopedRead === true && statement.includes('FROM article_prompt')) {
        return [] as T[]
      }

      const reader = await connection.runAndReadAll(statement)

      return reader.getRowObjectsJson() as T[]
    },
    run: async (statement: string) => {
      await connection.run(statement)
    },
    transaction: async (operation) => {
      return operation(database)
    },
  }

  return database
}

const createDuckdbHumanStatusFixture = async (input: {
  articleIds: readonly string[]
  humanJudgmentMode: 'prompt' | 'summary'
  promptIds: readonly string[]
}) => {
  const instance = await DuckDBInstance.create(':memory:', duckdbEngineCompatibilityOptions)
  const connection = await instance.connect()
  const sqlList = (values: readonly string[]) => {
    return values
      .map((value) => {
        return `'${value}'`
      })
      .join(', ')
  }

  await connection.run(`
    CREATE SCHEMA app;
    CREATE SCHEMA mart;
    CREATE TABLE app.project (
      id VARCHAR, human_judgment_mode VARCHAR, model_id VARCHAR, use_title BOOLEAN, use_abstract BOOLEAN,
      use_fulltext BOOLEAN, use_fulltext_no_images BOOLEAN, system_prompt_variant VARCHAR, use_metadata BOOLEAN,
      full_text_strategy_id VARCHAR
    );
    CREATE TABLE app.model (id VARCHAR, provider_connection_id VARCHAR, remote_model_id VARCHAR, variant VARCHAR, metadata_json VARCHAR);
    CREATE TABLE app.provider_connection (id VARCHAR, provider_kind VARCHAR, base_url VARCHAR);
    CREATE TABLE app.prompt (id VARCHAR, content_hash VARCHAR, original_text VARCHAR, archived BOOLEAN);
    CREATE TABLE app.project_prompt (id VARCHAR, project_id VARCHAR, prompt_id VARCHAR, prompt_order INTEGER, enabled BOOLEAN, archived BOOLEAN);
    CREATE TABLE app."judgment_human" (
      id VARCHAR, project_id VARCHAR, article_id VARCHAR, prompt_id VARCHAR, answer VARCHAR,
      updated_at TIMESTAMPTZ DEFAULT current_timestamp
    );
    CREATE TABLE app."judgment_human_summary" (
      id VARCHAR, project_id VARCHAR, article_id VARCHAR, answer VARCHAR, origin VARCHAR,
      updated_at TIMESTAMPTZ DEFAULT current_timestamp
    );
    CREATE TABLE app.review_change_delta (
      delta_id VARCHAR, project_id VARCHAR, article_id VARCHAR, prompt_id VARCHAR, change_kind VARCHAR,
      source_operation VARCHAR, tombstone BOOLEAN, payload_json VARCHAR, source_updated_at TIMESTAMPTZ,
      human_judgment_key VARCHAR, source_partition VARCHAR, source_high_water_mark BIGINT
    );
    CREATE TABLE mart.project_scope_article (
      project_id VARCHAR, article_id VARCHAR, in_curated_scope BOOLEAN, in_route_scope BOOLEAN,
      article_created_at TIMESTAMPTZ, article_updated_at TIMESTAMPTZ
    );
    CREATE TABLE app.review_serving_snapshot_manifest (
      project_id VARCHAR, snapshot_id VARCHAR, review_config_hash VARCHAR, snapshot_status VARCHAR, component_state_json VARCHAR
    );
    CREATE TABLE mart.review_article_serving_base_v4 (
      project_id VARCHAR, review_config_hash VARCHAR, snapshot_id VARCHAR, article_id VARCHAR, base_generation BIGINT
    );
    CREATE TABLE mart.review_article_serving_list_mode_state_v4 (
      project_id VARCHAR, review_config_hash VARCHAR, snapshot_id VARCHAR, article_id VARCHAR,
      has_llm_list_mode BOOLEAN, has_human_list_mode BOOLEAN, has_both_list_mode BOOLEAN, has_unassessed_list_mode BOOLEAN,
      human_status VARCHAR, human_patch_watermark BIGINT, both_patch_watermark BIGINT
    );
    INSERT INTO app.project VALUES
      ('${duckdbProjectId}', '${input.humanJudgmentMode}', NULL, TRUE, TRUE, FALSE, FALSE, 'legacy', FALSE, NULL);
  `)

  if (input.promptIds.length > 0) {
    await connection.run(`
      INSERT INTO app.prompt SELECT id, 'hash-' || id, 'text ' || id, FALSE FROM (SELECT unnest([${sqlList(input.promptIds)}]) AS id);
      INSERT INTO app.project_prompt
      SELECT 'pp-' || id, '${duckdbProjectId}', id, row_number() OVER (ORDER BY id), TRUE, FALSE
      FROM (SELECT unnest([${sqlList(input.promptIds)}]) AS id);
    `)
  }

  const database = getDuckdbHumanStatusDatabase(connection)
  const reviewConfigHash = getReviewServingReviewConfigHash({
    ...((await getReviewServingProjectReviewSettings(
      duckdbProjectId,
      database,
    )) as ReviewServingProjectReviewSettingsRow),
    promptConfigRows: await getReviewServingProjectPromptConfigRows(duckdbProjectId, database),
  })

  await connection.run(`
    INSERT INTO app.review_serving_snapshot_manifest VALUES (
      '${duckdbProjectId}', '${duckdbSnapshotId}', '${reviewConfigHash}', 'active',
      '{"required":[{"component":"humanStatus","projectionIdentity":"${duckdbProjectionIdentity}"}],"optional":[]}'
    );
    INSERT INTO mart.project_scope_article
    SELECT '${duckdbProjectId}', article_id, TRUE, FALSE, TIMESTAMPTZ '2026-11-01 00:00:00+00', NULL
    FROM (SELECT unnest([${sqlList(input.articleIds)}]) AS article_id);
    INSERT INTO mart.review_article_serving_base_v4
    SELECT '${duckdbProjectId}', '${reviewConfigHash}', '${duckdbSnapshotId}', article_id, 5
    FROM (SELECT unnest([${sqlList(input.articleIds)}]) AS article_id);
    INSERT INTO mart.review_article_serving_list_mode_state_v4
    SELECT '${duckdbProjectId}', '${reviewConfigHash}', '${duckdbSnapshotId}', article_id, TRUE, TRUE, TRUE, FALSE, 'unanswered', 0, 0
    FROM (SELECT unnest([${sqlList(input.articleIds)}]) AS article_id);
  `)

  const getHumanStatuses = async () => {
    const reader = await connection.runAndReadAll(`
      SELECT article_id, human_status
      FROM mart.review_article_serving_list_mode_state_v4
      ORDER BY article_id
    `)

    return Object.fromEntries(
      (reader.getRowObjectsJson() as Array<{article_id: string; human_status: string | null}>).map((row) => {
        return [row.article_id, row.human_status]
      }),
    )
  }
  const close = () => {
    connection.closeSync()
  }

  return {close, connection, database, getHumanStatuses}
}

const duckdbPatchInput = (claims: readonly ReviewServingDirtyWorkClaim[]) => {
  return {
    acknowledgeClaims: false,
    baseGeneration: 5,
    claims,
    definitionVersion: 'human-status-v4-test',
    listModeKeys: ['human', 'both'],
    projectId: duckdbProjectId,
    projectionIdentity: duckdbProjectionIdentity,
  }
}

const projectScopeClaim = (articleId: string) => {
  return humanClaim({
    articleId,
    dirtyKind: 'projectScope.article.added',
    scopeId: `${duckdbProjectId}:${articleId}`,
    sourcePartition: `project:${duckdbProjectId}`,
  })
}

test('summary-mode article entering scope with a summary answer is answered even with enabled prompts (DuckDB)', async () => {
  const fixture = await createDuckdbHumanStatusFixture({
    articleIds: ['article-1', 'article-2'],
    humanJudgmentMode: 'summary',
    promptIds: ['prompt-1', 'prompt-2'],
  })

  try {
    await fixture.connection.run(`
      INSERT INTO app."judgment_human_summary" (id, project_id, article_id, answer, origin) VALUES
        ('summary-row-1', '${duckdbProjectId}', 'article-1', 'no', 'covidence_import'),
        ('summary-row-2', '${duckdbProjectId}', 'article-2', NULL, 'covidence_import');
    `)

    await projectReviewServingHumanStatusPatches(
      duckdbPatchInput([projectScopeClaim('article-1'), projectScopeClaim('article-2')]),
      fixture.database,
    )

    expect(await fixture.getHumanStatuses()).toEqual({'article-1': 'answered', 'article-2': 'unanswered'})
  } finally {
    fixture.close()
  }
})

test('prompt-mode article status needs every enabled prompt answered and ignores summary rows (DuckDB)', async () => {
  const fixture = await createDuckdbHumanStatusFixture({
    articleIds: ['article-1'],
    humanJudgmentMode: 'prompt',
    promptIds: ['prompt-1', 'prompt-2'],
  })

  try {
    await fixture.connection.run(`
      INSERT INTO app."judgment_human" (id, project_id, article_id, prompt_id, answer) VALUES
        ('human-row-1', '${duckdbProjectId}', 'article-1', 'prompt-1', 'yes');
      INSERT INTO app."judgment_human_summary" (id, project_id, article_id, answer, origin) VALUES
        ('summary-row-1', '${duckdbProjectId}', 'article-1', NULL, 'covidence_import');
    `)

    await projectReviewServingHumanStatusPatches(duckdbPatchInput([projectScopeClaim('article-1')]), fixture.database)
    expect(await fixture.getHumanStatuses()).toEqual({'article-1': 'unanswered'})

    await fixture.connection.run(`
      INSERT INTO app."judgment_human" (id, project_id, article_id, prompt_id, answer) VALUES
        ('human-row-2', '${duckdbProjectId}', 'article-1', 'prompt-2', 'no');
    `)
    await projectReviewServingHumanStatusPatches(duckdbPatchInput([projectScopeClaim('article-1')]), fixture.database)
    expect(await fixture.getHumanStatuses()).toEqual({'article-1': 'answered'})
  } finally {
    fixture.close()
  }
})

test('article leaving project scope gets no human status even with a human answer delta (DuckDB)', async () => {
  const fixture = await createDuckdbHumanStatusFixture({
    articleIds: ['article-1'],
    humanJudgmentMode: 'summary',
    promptIds: ['prompt-1'],
  })

  try {
    await fixture.connection.run(`
      INSERT INTO app."judgment_human_summary" (id, project_id, article_id, answer, origin) VALUES
        ('summary-row-1', '${duckdbProjectId}', 'article-1', 'yes', 'manual_override');
      INSERT INTO app.review_change_delta VALUES (
        'delta-1', '${duckdbProjectId}', 'article-1', NULL, 'judgment.human.updated', 'upsert', FALSE,
        '{"answer":"yes"}', TIMESTAMPTZ '2026-11-08 22:13:00+00', '${duckdbProjectId}:article-1:summary',
        'humanJudgment:${duckdbProjectId}:article-1', 12
      );
      DELETE FROM mart.project_scope_article WHERE article_id = 'article-1';
    `)

    await projectReviewServingHumanStatusPatches(
      duckdbPatchInput([
        humanClaim({sourcePartition: `humanJudgment:${duckdbProjectId}:article-1`}),
        humanClaim({
          dirtyKind: 'projectScope.article.removed',
          dirtyWorkId: 'dirty-work-2',
          sourcePartition: `project:${duckdbProjectId}`,
        }),
      ]),
      fixture.database,
    )

    expect(await fixture.getHumanStatuses()).toEqual({'article-1': null})
  } finally {
    fixture.close()
  }
})

test('human answer deltas with composite judgment keys and no payload answer read the answer from the table (DuckDB)', async () => {
  const fixture = await createDuckdbHumanStatusFixture({
    articleIds: ['article-1'],
    humanJudgmentMode: 'summary',
    promptIds: ['prompt-1'],
  })
  const database = getDuckdbHumanStatusDatabase(fixture.connection, {skipArticleScopedRead: true})

  try {
    await fixture.connection.run(`
      INSERT INTO app."judgment_human_summary" (id, project_id, article_id, answer, origin) VALUES
        ('summary-row-id-not-the-delta-key', '${duckdbProjectId}', 'article-1', 'no', 'covidence_import');
      INSERT INTO app.review_change_delta VALUES (
        'delta-1', '${duckdbProjectId}', 'article-1', NULL, 'judgment.human.updated', 'upsert', FALSE,
        '{"origin":"covidence_import"}', TIMESTAMPTZ '2026-11-08 22:13:00+00', '${duckdbProjectId}:article-1:summary',
        'humanJudgment:${duckdbProjectId}:article-1', 13
      );
    `)

    await projectReviewServingHumanStatusPatches(
      duckdbPatchInput([humanClaim({sourcePartition: `humanJudgment:${duckdbProjectId}:article-1`})]),
      database,
    )

    expect(await fixture.getHumanStatuses()).toEqual({'article-1': 'answered'})
  } finally {
    fixture.close()
  }
})

test('prompt human answer deltas with composite judgment keys read the prompt row by natural key (DuckDB)', async () => {
  const fixture = await createDuckdbHumanStatusFixture({
    articleIds: ['article-1'],
    humanJudgmentMode: 'prompt',
    promptIds: ['prompt-1'],
  })
  const database = getDuckdbHumanStatusDatabase(fixture.connection, {skipArticleScopedRead: true})

  try {
    await fixture.connection.run(`
      INSERT INTO app."judgment_human" (id, project_id, article_id, prompt_id, answer) VALUES
        ('human-row-id', '${duckdbProjectId}', 'article-1', 'prompt-1', 'maybe');
      INSERT INTO app.review_change_delta VALUES (
        'delta-1', '${duckdbProjectId}', 'article-1', 'prompt-1', 'judgment.human.updated', 'upsert', FALSE,
        '{}', TIMESTAMPTZ '2026-11-08 22:13:00+00', '${duckdbProjectId}:article-1:prompt-1',
        'humanJudgment:${duckdbProjectId}:article-1', 13
      );
    `)

    await projectReviewServingHumanStatusPatches(
      duckdbPatchInput([humanClaim({sourcePartition: `humanJudgment:${duckdbProjectId}:article-1`})]),
      database,
    )

    expect(await fixture.getHumanStatuses()).toEqual({'article-1': 'answered'})
  } finally {
    fixture.close()
  }
})

test('range replacement and patch path agree that a prompt row without an answer is unanswered (DuckDB)', async () => {
  const fixture = await createDuckdbHumanStatusFixture({
    articleIds: ['article-1', 'article-2'],
    humanJudgmentMode: 'prompt',
    promptIds: ['prompt-1'],
  })

  try {
    await fixture.connection.run(`
      INSERT INTO app."judgment_human" (id, project_id, article_id, prompt_id, answer) VALUES
        ('human-row-1', '${duckdbProjectId}', 'article-1', 'prompt-1', NULL),
        ('human-row-2', '${duckdbProjectId}', 'article-2', 'prompt-1', 'yes');
    `)

    await projectReviewServingHumanStatusRanges(
      {ranges: [{...duckdbPatchInput([]), chunkEndArticleId: null, chunkStartArticleId: null}]},
      fixture.database,
    )
    expect(await fixture.getHumanStatuses()).toEqual({'article-1': 'unanswered', 'article-2': 'answered'})

    await fixture.connection.run(`UPDATE mart.review_article_serving_list_mode_state_v4 SET human_status = NULL`)
    await projectReviewServingHumanStatusPatches(
      duckdbPatchInput([projectScopeClaim('article-1'), projectScopeClaim('article-2')]),
      fixture.database,
    )
    expect(await fixture.getHumanStatuses()).toEqual({'article-1': 'unanswered', 'article-2': 'answered'})
  } finally {
    fixture.close()
  }
})
