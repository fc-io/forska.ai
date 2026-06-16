import {expect, test} from 'bun:test'

import {type ReviewServingDirtyWorkClaim} from './reviewServingDirtyWorkService.ts'
import {
  projectReviewServingQueuePatches,
  type ReviewServingQueueProjectorDatabase,
} from './reviewServingQueueProjector.ts'

const createQueueDatabase = (input?: {queueRows?: readonly Record<string, unknown>[]}) => {
  const statements: string[] = []
  const database: ReviewServingQueueProjectorDatabase = {
    queryJson: async <T>(statement: string) => {
      statements.push(statement)

      if (statement.includes('FROM app.review_source_change_outbox')) {
        return [] as T[]
      }

      if (statement.includes('FROM queue_union queue')) {
        return (input?.queueRows ?? []) as T[]
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

const queueRow = (input?: Record<string, unknown>) => {
  return {
    activitySortAt: '2026-06-16T10:00:00.000Z',
    articleId: 'article-1',
    priorityBucket: 0,
    promptId: 'prompt-1',
    queueIdentity: null,
    queueKind: 'unassessed',
    reviewConfigHash: 'review-config-1',
    tombstone: false,
    ...input,
  }
}

const queueClaim = (input?: Partial<ReviewServingDirtyWorkClaim>): ReviewServingDirtyWorkClaim => {
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
    projectionComponent: 'queue',
    projectionIdentity: 'queue:identity-1',
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
    definitionVersion: 'queue-v4-test',
    projectId: 'project-1',
    projectScopeIdentity: 'project-scope-1',
    projectionIdentity: 'queue:identity-1',
    selectedImportSnapshotId: 'selected-snapshot-1',
    snapshotId: 'snapshot-1',
  }
}

test('LLM answer changes write unassessed queue patches and serving rows from completed status marts', async () => {
  const {database, statements} = createQueueDatabase({queueRows: [queueRow()]})

  const result = await projectReviewServingQueuePatches(projectInput([queueClaim()]), database)
  const selectStatement = statements.find((statement) => {
    return statement.includes('FROM queue_union queue')
  })
  const patchInsert = statements.find((statement) => {
    return statement.includes('INSERT INTO mart.review_queue_patch_v4')
  })
  const servingInsert = statements.find((statement) => {
    return statement.includes('INSERT INTO mart.review_unassessed_queue_serving_v4')
  })

  expect(result).toEqual({patchRowCount: 1, patchWatermark: 14, servingRowCount: 1})
  expect(selectStatement).toContain('INNER JOIN mart.review_llm_status_patch_v4 llm')
  expect(selectStatement).toContain('INNER JOIN mart.review_human_status_patch_v4 human')
  expect(selectStatement).toContain('LEFT JOIN app.review_selected_article_import_v4 selected_base')
  expect(selectStatement).toContain('LEFT JOIN mart.review_selected_import_patch_v4 selected_patch')
  expect(selectStatement).toContain('INNER JOIN mart.project_scope_article scope')
  expect(selectStatement).toContain("VALUES ('article-1')")
  expect(patchInsert).toContain('queue_identity')
  expect(patchInsert).toContain('priority_bucket')
  expect(patchInsert).toContain('sort_key')
  expect(patchInsert).toContain("'unassessed'")
  expect(servingInsert).toContain('prompt_id')
  expect(servingInsert).toContain("'prompt-1'")
})

test('human status changes write related review queue patches without raw human judgment reads', async () => {
  const {database, statements} = createQueueDatabase({
    queueRows: [queueRow({queueKind: 'human-unreviewed', reviewConfigHash: null})],
  })

  const result = await projectReviewServingQueuePatches(
    projectInput([
      queueClaim({dirtyKind: 'judgment.human.updated', sourcePartition: 'humanJudgment:project-1:article-1'}),
    ]),
    database,
  )
  const patchInsert = statements.find((statement) => {
    return statement.includes('INSERT INTO mart.review_queue_patch_v4')
  })
  const joined = statements.join('\n')

  expect(result).toEqual({patchRowCount: 1, patchWatermark: 14, servingRowCount: 0})
  expect(patchInsert).toContain("'human-unreviewed'")
  expect(joined).toContain('INNER JOIN mart.review_human_status_patch_v4 human')
  expect(joined).not.toContain('FROM app."judgment_human"')
})

test('answered or deleted status rows write queue tombstones without serving rows', async () => {
  const {database, statements} = createQueueDatabase({queueRows: [queueRow({tombstone: true})]})

  const result = await projectReviewServingQueuePatches(
    projectInput([queueClaim({dirtyKind: 'judgment.llm.deleted'})]),
    database,
  )
  const patchInsert = statements.find((statement) => {
    return statement.includes('INSERT INTO mart.review_queue_patch_v4')
  })
  const servingInsert = statements.find((statement) => {
    return statement.includes('INSERT INTO mart.review_unassessed_queue_serving_v4')
  })

  expect(result).toEqual({patchRowCount: 1, patchWatermark: 14, servingRowCount: 0})
  expect(patchInsert).toContain('TRUE')
  expect(servingInsert).toBeUndefined()
})

test('prompt config changes rebuild only prompt-scoped queue rows', async () => {
  const {database, statements} = createQueueDatabase({queueRows: [queueRow({articleId: 'article-2'})]})

  const result = await projectReviewServingQueuePatches(
    projectInput([
      queueClaim({
        articleId: null,
        dirtyKind: 'prompt.config.updated',
        scopeId: 'project-1:prompt-1',
        scopeKind: 'prompt',
      }),
    ]),
    database,
  )
  const selectStatement = statements.find((statement) => {
    return statement.includes('FROM queue_union queue')
  })

  expect(result).toEqual({patchRowCount: 1, patchWatermark: 14, servingRowCount: 1})
  expect(selectStatement).toContain('prompt_id_filter(prompt_id)')
  expect(selectStatement).toContain("VALUES ('prompt-1')")
  expect(selectStatement).toContain('ON dirty_prompt.prompt_id = llm.prompt_id')
  expect(selectStatement).toContain('ON dirty_prompt.prompt_id = human.prompt_id')
  expect(selectStatement).toContain('FROM mart.project_scope_article scope')
})

test('membership removals write tombstones and keep queue projection component narrow', async () => {
  const {database, statements} = createQueueDatabase({queueRows: [queueRow({tombstone: true})]})

  await projectReviewServingQueuePatches(
    projectInput([queueClaim({dirtyKind: 'projectScope.article.removed'})]),
    database,
  )
  const joined = statements.join('\n')

  expect(joined).toContain('scope_tombstone')
  expect(joined).toContain('INSERT INTO app.review_serving_dirty_work_ack')
  expect(joined).toContain('INSERT INTO app.review_serving_projector_watermark')
  expect(joined).toContain("'queue'")
  expect(joined).not.toContain('FROM app."judgment"')
  expect(joined).not.toContain('FROM app."judgment_human"')
})

test('missing queue inputs leave optional unassessed state stale without raw aggregation', async () => {
  const {database, statements} = createQueueDatabase()

  const result = await projectReviewServingQueuePatches(projectInput([queueClaim()]), database)
  const joined = statements.join('\n')

  expect(result).toEqual({patchRowCount: 0, patchWatermark: 14, servingRowCount: 0})
  expect(joined).not.toContain('mart.judgment_fact')
  expect(joined).not.toContain('app."judgment"')
  expect(joined).not.toContain('GROUP BY')
})
