import {expect, test} from 'bun:test'

import {type ReviewServingDirtyWorkClaim} from './reviewServingDirtyWorkService.ts'
import {
  projectReviewServingLlmStatusPatches,
  type ReviewServingLlmStatusProjectorDatabase,
} from './reviewServingLlmStatusProjector.ts'

const createLlmStatusDatabase = (input?: {
  judgmentRows?: readonly Record<string, unknown>[]
  promptConfigRows?: readonly Record<string, unknown>[]
  promptRows?: readonly Record<string, unknown>[]
}) => {
  const statements: string[] = []
  const database: ReviewServingLlmStatusProjectorDatabase = {
    queryJson: async <T>(statement: string) => {
      statements.push(statement)

      if (statement.includes('FROM app.review_source_change_outbox')) {
        return [] as T[]
      }

      if (statement.includes('FROM app.project_prompt project_prompt')) {
        return (input?.promptConfigRows ?? [promptConfigRow()]) as T[]
      }

      if (statement.includes('FROM app.review_change_delta delta')) {
        return (input?.judgmentRows ?? []) as T[]
      }

      if (statement.includes('FROM prompt_id_filter dirty_prompt')) {
        return (input?.promptRows ?? []) as T[]
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
    listModeKeys: ['global'],
    projectId: 'project-1',
    projectionIdentity: 'llmStatus:identity-1',
  }
}

test('LLM judgment deltas write component-narrow status patches from persisted benchmark config', async () => {
  const {database, statements} = createLlmStatusDatabase({judgmentRows: [llmStatusRow()]})

  const result = await projectReviewServingLlmStatusPatches(projectInput([llmClaim()]), database)
  const selectStatement = statements.find((statement) => {
    return statement.includes('FROM app.review_change_delta delta')
  })
  const insertStatement = statements.find((statement) => {
    return statement.includes('INSERT INTO mart.review_llm_status_patch_v4')
  })

  expect(result).toEqual({patchRowCount: 1, patchWatermark: 14})
  expect(selectStatement).toContain('delta.model_id AS modelId')
  expect(selectStatement).toContain('judgment.model_id = delta.model_id')
  expect(selectStatement).toContain('judgment.use_fulltext_no_images = delta.use_fulltext_no_images')
  expect(selectStatement).toContain("VALUES ('article-1')")
  expect(insertStatement).toContain('review_config_hash')
  expect(insertStatement).toContain('prompt_config_hash')
  expect(insertStatement).toContain('llm_status_key')
  expect(insertStatement).toContain("'answered'")
  expect(insertStatement).toContain("'include'")
  expect(insertStatement).toContain(
    'ON CONFLICT(project_id, review_config_hash, prompt_config_hash, base_generation, patch_watermark, list_mode_key, article_id, prompt_id)',
  )
})

test('LLM deletes write idempotent tombstone patches without rebuilding unrelated components', async () => {
  const {database, statements} = createLlmStatusDatabase({
    judgmentRows: [
      llmStatusRow({answeredOriginal: null, answeredOriginalAsArray: null, isAnswered: null, tombstone: true}),
    ],
  })

  await projectReviewServingLlmStatusPatches(projectInput([llmClaim({dirtyKind: 'judgment.llm.deleted'})]), database)
  await projectReviewServingLlmStatusPatches(projectInput([llmClaim({dirtyKind: 'judgment.llm.deleted'})]), database)

  const joined = statements.join('\n')
  const patchInserts = statements.filter((statement) => {
    return statement.includes('INSERT INTO mart.review_llm_status_patch_v4')
  })

  expect(patchInserts).toHaveLength(2)
  expect(patchInserts[0]).toContain('TRUE')
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

  expect(result).toEqual({patchRowCount: 1, patchWatermark: 14})
  expect(promptSelect).toContain("VALUES ('prompt-1')")
  expect(promptSelect).toContain('INNER JOIN app.project project')
  expect(promptSelect).toContain('INNER JOIN mart.project_scope_article scope')
  expect(promptSelect).toContain('judgment.prompt_id = dirty_prompt.prompt_id')
  expect(promptSelect).toContain('judgment.model_id = project.model_id')
  expect(promptSelect).toContain('judgment.use_title = project.use_title')
  expect(promptSelect).toContain('judgment.use_abstract = project.use_abstract')
  expect(promptSelect).toContain('judgment.use_fulltext = project.use_fulltext')
  expect(promptSelect).toContain('judgment.use_fulltext_no_images = project.use_fulltext_no_images')
  expect(deltaSelect).toBeUndefined()
})
