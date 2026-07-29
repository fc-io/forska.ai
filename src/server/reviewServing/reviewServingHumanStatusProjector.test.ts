import {expect, test} from 'bun:test'

import {type ReviewServingDirtyWorkClaim} from './reviewServingDirtyWorkService.ts'
import {
  projectReviewServingHumanStatusPatches,
  projectReviewServingHumanStatusRanges,
  type ReviewServingHumanStatusProjectorDatabase,
} from './reviewServingHumanStatusProjector.ts'
import {createReviewServingManifestTestStore} from './reviewServingManifestTestStore.ts'
import {
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
  const manifestStore = createReviewServingManifestTestStore()
  const database: ReviewServingHumanStatusProjectorDatabase = {
    queryJson: async <T>(statement: string) => {
      statements.push(statement)
      const manifestResult = manifestStore.getQueryResult<T>(statement)

      if (manifestResult !== null) {
        return manifestResult
      }

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
      manifestStore.run(statement)
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
    humanJudgmentMode: 'prompt',
    modelExecutionOptions: '{"thinking":{"effort":"medium"}}',
    modelId: 'model-1',
    modelProviderBaseUrl: 'https://provider.example',
    modelProviderConnectionId: 'provider-1',
    modelProviderKind: 'openai-compatible',
    modelRemoteModelId: 'remote-model-1',
    modelVariant: 'thinking',
    useAbstract: true,
    useFulltext: false,
    useFulltextNoImages: false,
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
  expect(joined).not.toContain('INSERT INTO app.review_serving_dirty_work_ack')
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
  })

  const result = await projectReviewServingHumanStatusPatches(projectInput([humanClaim()]), database)
  const joined = statements.join('\n')

  expect(result).toEqual({patchRowCount: 0, patchWatermark: 14})
  expect(joined).not.toContain('mart.review_human_status_patch_v4')
  expect(joined).toContain("'summary', 'answered', FALSE")
  expect(joined).toContain("'humanStatus'")
  expect(joined).toContain('INSERT INTO app.review_serving_dirty_work_ack')
  expect(joined).toContain('INSERT INTO app.review_serving_projector_watermark')
  expect(joined).toContain('WHERE NOT EXISTS')
  expect(joined).not.toContain("'llmStatus'")
})

test('Covidence summary conflicts count as reviewed while preserving null answer value', async () => {
  const {database, statements} = createHumanStatusDatabase({
    judgmentRows: [
      humanStatusRow({
        humanAnsweredValue: null,
        promptId: null,
        promptOrSummaryKey: 'summary',
        summaryOrigin: 'covidence_import',
      }),
    ],
  })

  const result = await projectReviewServingHumanStatusPatches(projectInput([humanClaim()]), database)
  const joined = statements.join('\n')

  expect(result).toEqual({patchRowCount: 0, patchWatermark: 14})
  expect(joined).not.toContain('mart.review_human_status_patch_v4')
  expect(joined).toContain("'summary', 'answered', FALSE")
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
  expect(joined).toContain(
    "json_extract_string(snapshot.composed_identity_json, '$.humanStatus.projectionIdentity') = 'humanStatus:identity-1'",
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
  expect(joined).toContain(
    "json_extract_string(snapshot.composed_identity_json, '$.humanStatus.projectionIdentity') = 'humanStatus:identity-1'",
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
})
