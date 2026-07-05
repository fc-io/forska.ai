import {expect, test} from 'bun:test'

import {type ReviewServingDirtyWorkClaim} from './reviewServingDirtyWorkService.ts'
import {
  projectReviewServingHumanStatusPatches,
  type ReviewServingHumanStatusProjectorDatabase,
} from './reviewServingHumanStatusProjector.ts'
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

test('human prompt answer deltas write component-narrow status patches', async () => {
  const {database, statements} = createHumanStatusDatabase({judgmentRows: [humanStatusRow()]})

  const result = await projectReviewServingHumanStatusPatches(projectInput([humanClaim()]), database)
  const selectStatement = statements.find((statement) => {
    return statement.includes('FROM app.review_change_delta delta')
  })
  const insertStatement = statements.find((statement) => {
    return statement.includes('INSERT INTO mart.review_human_status_patch_v4')
  })
  const joined = statements.join('\n')

  expect(result).toEqual({patchRowCount: 1, patchWatermark: 14})
  expect(selectStatement).toContain('LEFT JOIN app."judgment_human" judgment_human')
  expect(selectStatement).toContain('LEFT JOIN app."judgment_human_summary" judgment_human_summary')
  expect(selectStatement).toContain("VALUES ('article-1')")
  expect(insertStatement).toContain('prompt_config_hash')
  expect(insertStatement).toContain('human_status_key')
  expect(insertStatement).toContain('human_answered_value')
  expect(insertStatement).toContain("'answered'")
  expect(insertStatement).toContain("'yes'")
  expect(insertStatement).toContain(
    'ON CONFLICT(project_id, prompt_config_hash, base_generation, patch_watermark, list_mode_key, article_id, prompt_id)',
  )
  expect(joined).toContain('UPDATE mart.review_article_serving_v4 serving')
  expect(joined).toContain('human_answered_prompt_count')
  expect(joined).toContain('human_answered_summary_count')
  expect(joined).toContain('review_config_hash')
  expect(joined).toContain('serving.review_config_hash IS NOT DISTINCT FROM article_status.review_config_hash')
  expect(joined.indexOf('article_status.human_answered_summary_count > 0')).toBeLessThan(
    joined.indexOf('serving.enabled_prompt_count = 0'),
  )
  expect(joined).toContain("prompt_id <> 'summary'")
  expect(joined).toContain('human_status_key')
  expect(joined).toContain("'humanStatus'")
  expect(joined).not.toContain('scope.source_updated_at')
  expect(joined).not.toContain("'llmStatus'")
  expect(joined).not.toContain("'selectedImport'")
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

test('summary human answers do not require prompt IDs and write summary-key patches', async () => {
  const {database, statements} = createHumanStatusDatabase({
    judgmentRows: [humanStatusRow({promptId: null, promptOrSummaryKey: 'summary'})],
  })

  const result = await projectReviewServingHumanStatusPatches(projectInput([humanClaim()]), database)
  const insertStatement = statements.find((statement) => {
    return statement.includes('INSERT INTO mart.review_human_status_patch_v4')
  })
  const joined = statements.join('\n')

  expect(result).toEqual({patchRowCount: 1, patchWatermark: 14})
  expect(insertStatement).toContain("'summary'")
  expect(joined).toContain("'summary', 'answered', FALSE")
  expect(joined).toContain("'humanStatus'")
  expect(joined).toContain('INSERT INTO app.review_serving_dirty_work_ack')
  expect(joined).toContain('INSERT INTO app.review_serving_projector_watermark')
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
  const insertStatement = statements.find((statement) => {
    return statement.includes('INSERT INTO mart.review_human_status_patch_v4')
  })
  const joined = statements.join('\n')

  expect(result).toEqual({patchRowCount: 1, patchWatermark: 14})
  expect(insertStatement).toContain('NULL')
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
  const patchInserts = statements.filter((statement) => {
    return statement.includes('INSERT INTO mart.review_human_status_patch_v4')
  })

  expect(result).toEqual({patchRowCount: 2, patchWatermark: 14})
  expect(patchInserts[0]).toContain("'old-prompt'")
  expect(patchInserts[0]).not.toContain("'latest'")
  expect(patchInserts[0]).toContain("'new-summary'")
  expect(patchInserts[0]).toContain("'summary'")
})

test('human answer deletes write idempotent tombstone patches', async () => {
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

  const patchInserts = statements.filter((statement) => {
    return statement.includes('INSERT INTO mart.review_human_status_patch_v4')
  })

  expect(patchInserts).toHaveLength(2)
  expect(patchInserts[0]).toContain('TRUE')
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

  expect(result).toEqual({patchRowCount: 1, patchWatermark: 14})
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

test('human rebuild chunks replace scoped patch rows before bounded inserts', async () => {
  const {database, statements} = createHumanStatusDatabase({projectRows: [humanStatusRow({articleId: 'article-3'})]})

  const result = await projectReviewServingHumanStatusPatches(
    {...projectInput([]), chunkEndArticleId: 'article-3', chunkStartArticleId: 'article-3'},
    database,
  )
  const deleteStatement = statements.find((statement) => {
    return statement.includes('DELETE FROM mart.review_human_status_patch_v4')
  })
  const insertStatement = statements.find((statement) => {
    return statement.includes('INSERT INTO mart.review_human_status_patch_v4')
  })
  const joined = statements.join('\n')

  expect(result).toEqual({patchRowCount: 1, patchWatermark: 0})
  expect(deleteStatement).toContain('patch_watermark = 0')
  expect(deleteStatement).toContain("article_id >= 'article-3'")
  expect(deleteStatement).toContain("article_id <= 'article-3'")
  expect(insertStatement).not.toContain('ON CONFLICT')
  expect(joined.indexOf('DELETE FROM mart.review_human_status_patch_v4')).toBeLessThan(
    joined.indexOf('INSERT INTO mart.review_human_status_patch_v4'),
  )
  expect(joined).toContain('UPDATE mart.review_article_serving_v4 serving')
  expect(joined.indexOf('DELETE FROM mart.review_human_status_patch_v4')).toBeLessThan(
    joined.indexOf('UPDATE mart.review_article_serving_v4 serving'),
  )
})

test('human direct full rebuild chunks update serving without patch rows', async () => {
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
  expect(joined).toContain('UPDATE mart.review_article_serving_v4 serving')
})

test('human rebuild chunks use one range delete and bounded insert batches', async () => {
  const {database, statements} = createHumanStatusDatabase({
    projectRows: Array.from({length: 251}, (_, index) => {
      return humanStatusRow({articleId: `article-${String(index).padStart(3, '0')}`})
    }),
  })

  const result = await projectReviewServingHumanStatusPatches(
    {...projectInput([]), chunkEndArticleId: 'article-250', chunkStartArticleId: 'article-000'},
    database,
  )
  const deleteStatements = statements.filter((statement) => {
    return statement.includes('DELETE FROM mart.review_human_status_patch_v4')
  })
  const insertStatements = statements.filter((statement) => {
    return statement.includes('INSERT INTO mart.review_human_status_patch_v4')
  })

  expect(result).toEqual({patchRowCount: 251, patchWatermark: 0})
  expect(deleteStatements).toHaveLength(1)
  expect(deleteStatements[0]).toContain("article_id >= 'article-000'")
  expect(deleteStatements[0]).toContain("article_id <= 'article-250'")
  expect(insertStatements).toHaveLength(2)
  expect(insertStatements.join('\n')).not.toContain('ON CONFLICT')
})
