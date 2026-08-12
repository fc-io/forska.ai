import {expect, test} from 'bun:test'

import {type ReviewServingDirtyWorkClaim} from './reviewServingDirtyWorkService.ts'
import {
  projectReviewServingLlmStatusPatches,
  projectReviewServingLlmStatusRanges,
  type ReviewServingLlmStatusProjectorDatabase,
} from './reviewServingLlmStatusProjector.ts'

const createLlmStatusDatabase = (input?: {
  judgmentRows?: readonly Record<string, unknown>[]
  projectRows?: readonly Record<string, unknown>[]
  promptConfigRows?: readonly Record<string, unknown>[]
  promptRows?: readonly Record<string, unknown>[]
  scopedArticleRows?: readonly Record<string, unknown>[]
}) => {
  const statements: string[] = []
  const database: ReviewServingLlmStatusProjectorDatabase = {
    queryJson: async <T>(statement: string) => {
      statements.push(statement)

      if (statement.includes('FROM app.review_source_change_outbox')) {
        return [] as T[]
      }

      if (statement.includes('scoped_article AS')) {
        return (input?.projectRows ?? []) as T[]
      }

      if (statement.includes('FROM app.review_change_delta delta')) {
        return (input?.judgmentRows ?? []) as T[]
      }

      if (statement.includes('FROM prompt_id_filter dirty_prompt')) {
        return (input?.promptRows ?? []) as T[]
      }

      if (statement.includes('FROM article_id_filter dirty')) {
        return (input?.scopedArticleRows ?? []) as T[]
      }

      if (statement.includes('FROM app.project_prompt project_prompt')) {
        return (input?.promptConfigRows ?? [promptConfigRow()]) as T[]
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

const llmStatusRow = (input?: Record<string, unknown>) => {
  return {
    answerSchemaHash: null,
    answeredOriginal: 'include',
    answeredOriginalAsArray: ['include'],
    articleId: 'article-1',
    isAnswered: true,
    latestLlmCreatedAt: '2026-06-16T10:00:00.000Z',
    humanJudgmentMode: 'prompt',
    modelId: 'model-delta',
    promptId: 'prompt-1',
    promptTextHash: 'prompt-text-1',
    settingsVersion: 'prompt-v1',
    sourceOperation: 'update',
    thresholdVersion: null,
    tombstone: false,
    useAbstract: false,
    useFulltext: true,
    useFulltextNoImages: true,
    useTitle: true,
    ...input,
  }
}

const llmClaim = (input?: Partial<ReviewServingDirtyWorkClaim>): ReviewServingDirtyWorkClaim => {
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
    projectionComponent: 'llmStatus',
    projectionIdentity: 'llmStatus:identity-1',
    scopeId: 'project-1:article-1',
    scopeKind: 'article',
    sourcePartition: 'llmJudgment:article-1',
    status: 'running',
    ...input,
  }
}

const projectInput = (claims: readonly ReviewServingDirtyWorkClaim[]) => {
  return {
    baseGeneration: 5,
    claims,
    definitionVersion: 'llm-status-v4-test',
    listModeKeys: ['llm'],
    projectId: 'project-1',
    projectionIdentity: 'llmStatus:identity-1',
  }
}

test('LLM judgment deltas update serving directly from persisted benchmark config', async () => {
  const {database, statements} = createLlmStatusDatabase({judgmentRows: [llmStatusRow()]})

  const result = await projectReviewServingLlmStatusPatches(projectInput([llmClaim()]), database)
  const selectStatement = statements.find((statement) => {
    return statement.includes('FROM app.review_change_delta delta')
  })
  expect(result).toEqual({patchRowCount: 0, patchWatermark: 14})
  expect(selectStatement).toContain('delta.model_id AS modelId')
  expect(selectStatement).toContain('model.provider_connection_id AS modelProviderConnectionId')
  expect(selectStatement).toContain('provider_connection.base_url AS modelProviderBaseUrl')
  expect(selectStatement).toContain("TO_JSON(json_extract(model.metadata_json, '$.options')) AS modelExecutionOptions")
  expect(selectStatement).toContain('LEFT JOIN app.provider_connection provider_connection')
  expect(selectStatement).toContain("COALESCE(project.human_judgment_mode, 'prompt') AS humanJudgmentMode")
  expect(selectStatement).toContain('LEFT JOIN app.project_prompt project_prompt')
  expect(selectStatement).toContain('project_prompt.id IS NULL OR NOT project_prompt.enabled')
  expect(selectStatement).toContain(
    'COALESCE(project_prompt.archived, FALSE) OR COALESCE(prompt.archived, FALSE) AS tombstone',
  )
  expect(selectStatement).toContain('judgment.article_id = delta.article_id')
  expect(selectStatement).toContain('judgment.prompt_id = delta.prompt_id')
  expect(selectStatement).toContain('judgment.model_id = delta.model_id')
  expect(selectStatement).toContain('judgment.use_fulltext_no_images = delta.use_fulltext_no_images')
  expect(selectStatement).toContain('FROM app."judgment" newer_judgment')
  expect(selectStatement).not.toContain('judgment.id = delta.judgment_id')
  expect(selectStatement).toContain("VALUES ('article-1')")
  expect(statements.join('\n')).not.toContain('mart.review_llm_status_patch_v4')
  expect(statements.join('\n')).toContain('UPDATE mart.review_article_serving_list_mode_state_v4 state')
})

test('LLM judgment deltas recompute all article prompts before updating article status', async () => {
  const {database, statements} = createLlmStatusDatabase({
    judgmentRows: [llmStatusRow({promptId: 'prompt-1'})],
    scopedArticleRows: [
      llmStatusRow({promptId: 'prompt-1'}),
      llmStatusRow({promptId: 'prompt-2', promptTextHash: 'prompt-text-2'}),
    ],
  })

  await projectReviewServingLlmStatusPatches(projectInput([llmClaim()]), database)
  const articleSelect = statements.find((statement) => {
    return (
      statement.includes('FROM article_id_filter dirty')
      && statement.includes('INNER JOIN app.project_prompt project_prompt')
    )
  })
  const updateStatement = statements.find((statement) => {
    return statement.includes('UPDATE mart.review_article_serving_list_mode_state_v4 state')
  })

  expect(articleSelect).toContain("VALUES ('article-1')")
  expect(updateStatement).toContain("'prompt-1'")
  expect(updateStatement).toContain("'prompt-2'")
})

test('LLM deletes update serving directly without rebuilding unrelated components', async () => {
  const {database, statements} = createLlmStatusDatabase({
    judgmentRows: [
      llmStatusRow({answeredOriginal: null, answeredOriginalAsArray: null, isAnswered: null, tombstone: true}),
    ],
  })

  await projectReviewServingLlmStatusPatches(projectInput([llmClaim({dirtyKind: 'judgment.llm.deleted'})]), database)
  await projectReviewServingLlmStatusPatches(projectInput([llmClaim({dirtyKind: 'judgment.llm.deleted'})]), database)

  const joined = statements.join('\n')
  expect(joined).not.toContain('mart.review_llm_status_patch_v4')
  expect(joined).toContain("'llmStatus'")
  expect(joined).toContain('INSERT INTO app.review_serving_dirty_work_ack')
  expect(joined).toContain('INSERT INTO app.review_serving_projector_watermark')
  expect(joined).not.toContain("'selectedImport'")
  expect(joined).not.toContain("'display'")
})

test('prompt config claims rebuild only prompt-scoped LLM status rows', async () => {
  const {database, statements} = createLlmStatusDatabase({promptRows: [llmStatusRow({articleId: 'article-2'})]})

  const result = await projectReviewServingLlmStatusPatches(
    projectInput([
      llmClaim({
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
  expect(promptSelect).toContain('INNER JOIN app.project project')
  expect(promptSelect).toContain("COALESCE(project.human_judgment_mode, 'prompt') AS humanJudgmentMode")
  expect(promptSelect).toContain('INNER JOIN mart.project_scope_article scope')
  expect(promptSelect).toContain('NULL AS isAnswered')
  expect(promptSelect).toContain('NULL AS answeredOriginal')
  expect(promptSelect).toContain('NULL AS latestLlmCreatedAt')
  expect(promptSelect).not.toContain('FROM app."judgment"')
  expect(promptSelect).toContain(
    'COALESCE(project_prompt.archived, FALSE) OR COALESCE(prompt.archived, FALSE) AS tombstone',
  )
  expect(deltaSelect).toBeUndefined()
})

test('project review config claims rebuild project-scoped LLM status rows', async () => {
  const {database, statements} = createLlmStatusDatabase({projectRows: [llmStatusRow({articleId: 'article-3'})]})

  const result = await projectReviewServingLlmStatusPatches(
    projectInput([
      llmClaim({
        articleId: null,
        dirtyKind: 'project.reviewConfig.updated',
        scopeId: 'project-1',
        scopeKind: 'project',
      }),
    ]),
    database,
  )
  const projectSelect = statements.find((statement) => {
    return statement.includes('FROM app.project project') && !statement.includes('FROM prompt_id_filter dirty_prompt')
  })

  expect(result).toEqual({patchRowCount: 0, patchWatermark: 14})
  expect(projectSelect).toContain('WITH prompt_id_filter(prompt_id) AS')
  expect(projectSelect).not.toContain('mart.review_llm_status_patch_v4')
  expect(projectSelect).toContain('LEFT JOIN app.project_prompt project_prompt')
  expect(projectSelect).toContain('scoped_article AS')
  expect(projectSelect).toContain('INNER JOIN scoped_article scoped_judgment')
  expect(projectSelect).toContain('INNER JOIN prompt_id_filter dirty_judgment_prompt')
  expect(projectSelect).toContain('FROM app."judgment" judgment')
  expect(projectSelect).toContain('ROW_NUMBER() OVER')
  expect(projectSelect).toContain('ORDER BY judgment.created_at DESC NULLS LAST, judgment.id DESC')
  expect(projectSelect).toContain('judgment.judgment_rank = 1')
  expect(projectSelect).toContain('judgment.model_id = project.model_id')
  expect(projectSelect).toContain('judgment.use_title = project.use_title')
  expect(projectSelect).toContain(
    'COALESCE(project_prompt.archived, FALSE) OR COALESCE(prompt.archived, FALSE) AS tombstone',
  )
})

test('LLM full rebuild chunks copy serving rows without prompt fanout source scans', async () => {
  const {database, statements} = createLlmStatusDatabase({projectRows: [llmStatusRow({articleId: 'article-3'})]})

  const result = await projectReviewServingLlmStatusPatches(
    {...projectInput([]), chunkEndArticleId: 'article-3', chunkStartArticleId: 'article-3'},
    database,
  )
  const projectSelect = statements.find((statement) => {
    return statement.includes('WITH prompt_id_filter(prompt_id) AS') && statement.includes('scoped_article AS')
  })
  const applyStatement = statements.find((statement) => {
    return statement.includes('UPDATE mart.review_article_serving_list_mode_state_v4 state')
  })

  expect(result).toEqual({patchRowCount: 0, patchWatermark: 0})
  expect(projectSelect).toBeUndefined()
  expect(applyStatement).toContain('FROM mart.review_article_serving_base_v4 serving')
  expect(applyStatement).toContain('WITH article_range_filter(chunk_start_article_id, chunk_end_article_id) AS')
  expect(applyStatement).toContain("('article-3', 'article-3')")
  expect(applyStatement).toContain('INNER JOIN article_range_filter range')
  expect(applyStatement).toContain('serving.article_id >= range.chunk_start_article_id')
  expect(applyStatement).toContain('serving.article_id <= range.chunk_end_article_id')
  expect(applyStatement).toContain('SET llm_status = article_status.llm_status')
  expect(applyStatement).toContain('llm_has_judgment = article_status.llm_has_judgment')
  expect(applyStatement).toContain('llm_patch_watermark =')
  expect(applyStatement).not.toContain('FROM mart.review_llm_status_patch_v4 llm')
  expect(applyStatement).toContain('FROM app.project_prompt project_prompt')
})

test('LLM direct full rebuild chunks copy-replace serving without patch rows', async () => {
  const {database, statements} = createLlmStatusDatabase({projectRows: [llmStatusRow({articleId: 'article-3'})]})

  const result = await projectReviewServingLlmStatusPatches(
    {...projectInput([]), chunkEndArticleId: 'article-3', chunkStartArticleId: 'article-3', emitPatchRows: false},
    database,
  )
  const joined = statements.join('\n')

  expect(result).toEqual({patchRowCount: 0, patchWatermark: 0})
  expect(joined).not.toContain('DELETE FROM mart.review_llm_status_patch_v4')
  expect(joined).not.toContain('INSERT INTO mart.review_llm_status_patch_v4')
  expect(joined).toContain('UPDATE mart.review_article_serving_list_mode_state_v4 state')
  expect(joined).toContain("json_each(json_extract(snapshot.component_state_json, '$.required'))")
  expect(joined).toContain("json_each(json_extract(snapshot.component_state_json, '$.optional'))")
  expect(joined).toContain("json_extract_string(component_state.value, '$.component') = 'llmStatus'")
  expect(joined).toContain(
    "json_extract_string(component_state.value, '$.projectionIdentity') = 'llmStatus:identity-1'",
  )
  expect(joined).not.toContain("json_extract_string(snapshot.composed_identity_json, '$.llmStatus.projectionIdentity')")
  expect(joined).not.toContain('replacement.llm_status_identity = serving.llm_status_identity')
  expect(joined).toContain('serving.base_generation = 5')
})

test('LLM full rebuild chunks reset serving status when the project has no enabled prompts', async () => {
  const {database, statements} = createLlmStatusDatabase({promptConfigRows: [], projectRows: []})

  const result = await projectReviewServingLlmStatusPatches(
    {...projectInput([]), chunkEndArticleId: 'article-9', chunkStartArticleId: 'article-1'},
    database,
  )
  const resetStatement = statements.find((statement) => {
    return statement.includes('UPDATE mart.review_article_serving_list_mode_state_v4 state')
  })
  const insertStatement = statements.find((statement) => {
    return statement.includes('INSERT INTO mart.review_llm_status_patch_v4')
  })
  const joined = statements.join('\n')

  expect(result).toEqual({patchRowCount: 0, patchWatermark: 0})
  expect(insertStatement).toBeUndefined()
  expect(resetStatement).not.toContain('llm_judged_prompt_count')
  expect(resetStatement).not.toContain('llm_status_key')
  expect(resetStatement).toContain('llm_status = article_status.llm_status')
  expect(resetStatement).toContain('llm_has_judgment = article_status.llm_has_judgment')
  expect(resetStatement).toContain('llm_patch_watermark =')
  expect(resetStatement).toContain("('article-1', 'article-9')")
  expect(resetStatement).toContain('serving.article_id >= range.chunk_start_article_id')
  expect(resetStatement).toContain('serving.article_id <= range.chunk_end_article_id')
  expect(resetStatement).toContain("snapshot.snapshot_status IN ('candidate', 'active')")
  expect(joined).toContain("json_each(json_extract(snapshot.component_state_json, '$.required'))")
  expect(joined).toContain("json_each(json_extract(snapshot.component_state_json, '$.optional'))")
  expect(joined).toContain("json_extract_string(component_state.value, '$.component') = 'llmStatus'")
  expect(joined).toContain(
    "json_extract_string(component_state.value, '$.projectionIdentity') = 'llmStatus:identity-1'",
  )
  expect(joined).not.toContain("json_extract_string(snapshot.composed_identity_json, '$.llmStatus.projectionIdentity')")
  expect(joined).not.toContain('replacement.llm_status_identity = serving.llm_status_identity')
  expect(joined).toContain('serving.base_generation = 5')
  expect(joined).not.toContain('mart.review_llm_status_patch_v4')
})

test('LLM rebuild chunks copy-replace serving without scoped patch rows', async () => {
  const {database, statements} = createLlmStatusDatabase({projectRows: [llmStatusRow({articleId: 'article-3'})]})

  const result = await projectReviewServingLlmStatusPatches(
    {...projectInput([]), chunkEndArticleId: 'article-3', chunkStartArticleId: 'article-3'},
    database,
  )
  const joined = statements.join('\n')

  expect(result).toEqual({patchRowCount: 0, patchWatermark: 0})
  expect(joined).not.toContain('mart.review_llm_status_patch_v4')
  expect(joined).toContain('UPDATE mart.review_article_serving_list_mode_state_v4 state')
  expect(joined).toContain("json_each(json_extract(snapshot.component_state_json, '$.required'))")
  expect(joined).toContain("json_each(json_extract(snapshot.component_state_json, '$.optional'))")
  expect(joined).toContain("json_extract_string(component_state.value, '$.component') = 'llmStatus'")
  expect(joined).toContain(
    "json_extract_string(component_state.value, '$.projectionIdentity') = 'llmStatus:identity-1'",
  )
  expect(joined).not.toContain("json_extract_string(snapshot.composed_identity_json, '$.llmStatus.projectionIdentity')")
  expect(joined).not.toContain('replacement.llm_status_identity = serving.llm_status_identity')
  expect(joined).toContain('serving.base_generation = 5')
})

test('LLM rebuild chunks avoid patch delete and insert batches', async () => {
  const {database, statements} = createLlmStatusDatabase({
    projectRows: Array.from({length: 251}, (_, index) => {
      return llmStatusRow({articleId: `article-${String(index).padStart(3, '0')}`})
    }),
  })

  const result = await projectReviewServingLlmStatusPatches(
    {...projectInput([]), chunkEndArticleId: 'article-250', chunkStartArticleId: 'article-000'},
    database,
  )
  expect(result).toEqual({patchRowCount: 0, patchWatermark: 0})
  expect(statements.join('\n')).not.toContain('mart.review_llm_status_patch_v4')
})

test('LLM range rebuild batches write one SQL-native serving replacement statement', async () => {
  const {database, statements} = createLlmStatusDatabase()

  const result = await projectReviewServingLlmStatusRanges(
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
    diagnosticsJson: {llmStatusProjector: {fullRebuildMode: string; rangeCount: number; sourceRowCount: number}}
  }

  expect(result).toEqual({patchRowCount: 0, patchWatermark: 0})
  expect(diagnostics.diagnosticsJson.llmStatusProjector).toMatchObject({
    fullRebuildMode: 'range-serving-set-based',
    rangeCount: 2,
    sourceRowCount: 0,
  })
  expect(replacementStatements).toHaveLength(1)
  expect(replacementStatements[0]).toContain('article_range_filter(chunk_start_article_id, chunk_end_article_id)')
  expect(replacementStatements[0]).toContain("('article-001', 'article-050'), ('article-051', 'article-099')")
  expect(joined).toContain('FROM app.project_prompt project_prompt')
  expect(joined).toContain('llm_status = article_status.llm_status')
  expect(joined).toContain('llm_has_judgment = article_status.llm_has_judgment')
  expect(joined).toContain('FROM app."judgment" judgment')
})

test('article judgment-input claims rebuild article-scoped LLM status rows', async () => {
  const {database, statements} = createLlmStatusDatabase({scopedArticleRows: [llmStatusRow()]})

  const result = await projectReviewServingLlmStatusPatches(
    projectInput([llmClaim({dirtyKind: 'article.judgmentInput.updated'})]),
    database,
  )
  const articleSelect = statements.find((statement) => {
    return statement.includes('FROM article_id_filter dirty')
  })

  expect(result).toEqual({patchRowCount: 0, patchWatermark: 14})
  expect(articleSelect).toContain("VALUES ('article-1')")
  expect(articleSelect).toContain('FROM app."judgment"')
  expect(articleSelect).toContain('judgment.judgment_rank = 1')
  expect(articleSelect).toContain('judgment.article_id = dirty.article_id')
})

test('newly scoped articles emit unanswered status rows for enabled prompts', async () => {
  const {database, statements} = createLlmStatusDatabase({
    promptConfigRows: [promptConfigRow(), promptConfigRow({promptId: 'prompt-2', promptTextHash: 'prompt-text-2'})],
    scopedArticleRows: [
      llmStatusRow({
        answeredOriginal: null,
        answeredOriginalAsArray: null,
        isAnswered: null,
        latestLlmCreatedAt: null,
        promptId: 'prompt-1',
      }),
      llmStatusRow({
        answeredOriginal: null,
        answeredOriginalAsArray: null,
        isAnswered: null,
        latestLlmCreatedAt: null,
        promptId: 'prompt-2',
        promptTextHash: 'prompt-text-2',
      }),
    ],
  })

  const result = await projectReviewServingLlmStatusPatches(
    projectInput([llmClaim({dirtyKind: 'projectScope.article.added', sourcePartition: 'projectScope:project-1'})]),
    database,
  )
  const articleSelect = statements.find((statement) => {
    return statement.includes('FROM article_id_filter dirty')
  })
  const joined = statements.join('\n')

  expect(result).toEqual({patchRowCount: 0, patchWatermark: 14})
  expect(articleSelect).toContain('INNER JOIN app.project_prompt project_prompt')
  expect(articleSelect).toContain('FROM app."judgment"')
  expect(articleSelect).toContain('judgment.judgment_rank = 1')
  expect(joined).toContain("'unanswered'")
  expect(joined).not.toContain('enabled_prompt_count =')
})
