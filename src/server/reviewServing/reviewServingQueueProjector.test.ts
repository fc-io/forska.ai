import {expect, test} from 'bun:test'

import {type ReviewServingDirtyWorkClaim} from './reviewServingDirtyWorkService.ts'
import {
  projectReviewServingQueuePatches,
  projectReviewServingQueueRebuildRows,
  type ReviewServingQueueProjectorDatabase,
} from './reviewServingQueueProjector.ts'

const createQueueDatabase = (input?: {
  queueRows?: readonly Record<string, unknown>[]
  reviewConfigHash?: string | null
}) => {
  const statements: string[] = []
  const database: ReviewServingQueueProjectorDatabase = {
    queryJson: async <T>(statement: string) => {
      statements.push(statement)

      if (statement.includes('FROM app.review_source_change_outbox')) {
        return [] as T[]
      }

      if (statement.includes('FROM app.review_serving_snapshot_manifest')) {
        return input?.reviewConfigHash === undefined
          ? ([] as T[])
          : ([{reviewConfigHash: input.reviewConfigHash}] as T[])
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

test('LLM answer changes acknowledge queue work without legacy patch rows', async () => {
  const {database, statements} = createQueueDatabase({queueRows: [queueRow()]})

  const result = await projectReviewServingQueuePatches(projectInput([queueClaim()]), database)
  const joined = statements.join('\n')
  const servingDelete = statements.find((statement) => {
    return statement.includes('DELETE FROM mart.review_unassessed_queue_serving_v4')
  })

  expect(result).toEqual({patchRowCount: 0, patchWatermark: 14, servingRowCount: 0})
  expect(joined).not.toContain('mart.review_queue_patch_v4')
  expect(joined).not.toContain('mart.review_llm_status_patch_v4')
  expect(joined).not.toContain('mart.review_human_status_patch_v4')
  expect(joined).not.toContain('mart.review_selected_import_patch_v4')
  expect(servingDelete).toContain('snapshot_id =')
  expect(servingDelete).toContain("article_id IN ('article-1')")
})

test('human status changes write related review queue patches without raw human judgment reads', async () => {
  const {database, statements} = createQueueDatabase({
    queueRows: [queueRow({queueKind: 'human-unreviewed', reviewConfigHash: 'review-config-1'})],
  })

  const result = await projectReviewServingQueuePatches(
    projectInput([
      queueClaim({dirtyKind: 'judgment.human.updated', sourcePartition: 'humanJudgment:project-1:article-1'}),
    ]),
    database,
  )
  const joined = statements.join('\n')

  expect(result).toEqual({patchRowCount: 0, patchWatermark: 14, servingRowCount: 0})
  expect(joined).not.toContain('mart.review_queue_patch_v4')
  expect(joined).not.toContain('mart.review_human_status_patch_v4')
  expect(joined).not.toContain('mart.review_llm_status_patch_v4')
  expect(joined).not.toContain('FROM app."judgment_human"')
})

test('answered or deleted status rows write queue tombstones without serving rows', async () => {
  const {database, statements} = createQueueDatabase({queueRows: [queueRow({tombstone: true})]})

  const result = await projectReviewServingQueuePatches(
    projectInput([queueClaim({dirtyKind: 'judgment.llm.deleted'})]),
    database,
  )
  const servingInsert = statements.find((statement) => {
    return statement.includes('INSERT INTO mart.review_unassessed_queue_serving_v4')
  })

  expect(result).toEqual({patchRowCount: 0, patchWatermark: 14, servingRowCount: 0})
  expect(statements.join('\n')).not.toContain('mart.review_queue_patch_v4')
  expect(servingInsert).toBeUndefined()
})

test('prompt config changes rebuild prompt-scoped and summary queue rows', async () => {
  const {database, statements} = createQueueDatabase({
    queueRows: [queueRow({articleId: 'article-2'}), queueRow({articleId: 'article-2', promptId: 'summary'})],
    reviewConfigHash: 'review-config-1',
  })

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
  const servingDelete = statements.find((statement) => {
    return statement.includes('DELETE FROM mart.review_unassessed_queue_serving_v4')
  })
  const queueSelect = statements.find((statement) => {
    return statement.includes('FROM queue_union queue')
  })

  expect(result).toEqual({patchRowCount: 0, patchWatermark: 14, servingRowCount: 2})
  expect(statements.join('\n')).not.toContain('mart.review_queue_patch_v4')
  expect(servingDelete).toContain("prompt_id IN ('prompt-1')")
  expect(servingDelete).toContain("OR prompt_id = 'summary'")
  expect(queueSelect).toContain("OR queue.prompt_id = 'summary'")
  expect(queueSelect?.match(/queue_union AS/g) ?? []).toHaveLength(1)
})

test('summary-mode queue rebuild tombstones imported Covidence summary decisions with empty answers', async () => {
  const {database, statements} = createQueueDatabase({
    queueRows: [queueRow({promptId: 'summary', queueKind: 'human-unreviewed', tombstone: true})],
    reviewConfigHash: 'review-config-1',
  })

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
  const queueSelect = statements.find((statement) => {
    return statement.includes('FROM queue_union queue')
  })

  expect(result).toEqual({patchRowCount: 0, patchWatermark: 14, servingRowCount: 0})
  expect(queueSelect).toContain("judgment_human_summary.origin = 'covidence_import'")
})

test('summary-mode human rows join queue work through article-level summary prompt', async () => {
  const {database, statements} = createQueueDatabase({
    queueRows: [queueRow({promptId: 'summary', queueKind: 'human-unreviewed'})],
  })

  const result = await projectReviewServingQueuePatches(
    projectInput([queueClaim({dirtyKind: 'judgment.human.updated'})]),
    database,
  )
  expect(result.patchRowCount).toBe(0)
  expect(statements.join('\n')).not.toContain('mart.review_queue_patch_v4')
})

test('queue rebuild treats missing LLM judgments as unassessed rows', async () => {
  const {database, statements} = createQueueDatabase()

  await projectReviewServingQueueRebuildRows(
    {
      baseGeneration: 5,
      projectId: 'project-1',
      projectScopeIdentity: 'project-scope-1',
      reviewConfigHash: 'review-config-1',
      selectedImportSnapshotId: 'selected-snapshot-1',
      snapshotId: 'snapshot-1',
    },
    database,
  )
  const joined = statements.join('\n')

  expect(joined).toContain('OR COALESCE(judgment.is_answered, FALSE)')
  expect(joined).not.toContain('OR judgment.is_answered\n')
})

test('summary-mode queue rebuild uses a synthetic human summary prompt without enabled prompts', async () => {
  const {database, statements} = createQueueDatabase()

  await projectReviewServingQueueRebuildRows(
    {
      baseGeneration: 5,
      projectId: 'project-1',
      projectScopeIdentity: 'project-scope-1',
      reviewConfigHash: 'review-config-1',
      selectedImportSnapshotId: 'selected-snapshot-1',
      snapshotId: 'snapshot-1',
    },
    database,
  )
  const insertStatement = statements.find((statement) => {
    return statement.includes('INSERT INTO mart.review_unassessed_queue_serving_v4')
  })

  expect(insertStatement).toContain('human_prompt AS')
  expect(insertStatement).toContain("SELECT\n        'summary' AS prompt_id")
  expect(insertStatement).toContain("WHERE project_settings.human_judgment_mode = 'summary'")
  expect(insertStatement).toContain('CROSS JOIN human_prompt prompt')
  expect(insertStatement).not.toContain('CASE WHEN project_settings.human_judgment_mode =')
})

test('prompt-mode queue rebuilds suppress synthetic summary human rows', async () => {
  const {database, statements} = createQueueDatabase({
    queueRows: [queueRow({promptId: 'prompt-1', queueKind: 'human-unreviewed'})],
  })

  await projectReviewServingQueuePatches(projectInput([queueClaim({dirtyKind: 'judgment.human.updated'})]), database)
  const joined = statements.join('\n')

  expect(joined).not.toContain('mart.review_queue_patch_v4')
  expect(joined).not.toContain('FROM queue_union queue')
})

test('project review config changes rebuild queue rows for all scoped project articles', async () => {
  const {database, statements} = createQueueDatabase({queueRows: [queueRow({articleId: 'article-2'})]})

  const result = await projectReviewServingQueuePatches(
    projectInput([
      queueClaim({
        articleId: null,
        dirtyKind: 'project.reviewConfig.updated',
        scopeId: 'project-1',
        scopeKind: 'project',
      }),
    ]),
    database,
  )
  const servingDelete = statements.find((statement) => {
    return statement.includes('DELETE FROM mart.review_unassessed_queue_serving_v4')
  })

  expect(result).toEqual({patchRowCount: 0, patchWatermark: 14, servingRowCount: 0})
  expect(statements.join('\n')).not.toContain('mart.review_queue_patch_v4')
  expect(servingDelete).not.toContain('article_id IN')
  expect(servingDelete).not.toContain('prompt_id IN')
})

test('queue rebuild rows read selected-import base rows without patch overlay', async () => {
  const {database, statements} = createQueueDatabase()

  await projectReviewServingQueueRebuildRows(
    {
      baseGeneration: 5,
      projectId: 'project-1',
      projectScopeIdentity: 'project-scope-1',
      reviewConfigHash: 'review-config-1',
      selectedImportSnapshotId: 'selected-snapshot-1',
      snapshotId: 'snapshot-1',
    },
    database,
  )
  const insertStatement = statements.find((statement) => {
    return statement.includes('INSERT INTO mart.review_unassessed_queue_serving_v4')
  })

  expect(insertStatement).toContain('LEFT JOIN app.review_selected_article_import_v4 selected_base')
  expect(insertStatement).not.toContain('mart.review_selected_import_patch_v4')
  expect(insertStatement).not.toContain('selected_patch')
})

test('membership removals write tombstones and keep queue projection component narrow', async () => {
  const {database, statements} = createQueueDatabase({queueRows: [queueRow({tombstone: true})]})

  await projectReviewServingQueuePatches(
    projectInput([queueClaim({dirtyKind: 'projectScope.article.removed'})]),
    database,
  )
  const joined = statements.join('\n')

  expect(joined).not.toContain('mart.review_queue_patch_v4')
  expect(joined).toContain('INSERT INTO app.review_serving_dirty_work_ack')
  expect(joined).toContain('INSERT INTO app.review_serving_projector_watermark')
  expect(joined).toContain("'queue'")
  expect(joined).not.toContain('FROM app."judgment"')
  expect(joined).not.toContain('FROM app."judgment_human"')
})

test('queue serving replacement deletes only projected review configs', async () => {
  const {database, statements} = createQueueDatabase({
    queueRows: [queueRow({reviewConfigHash: 'review-config-2'}), queueRow({reviewConfigHash: null})],
  })

  await projectReviewServingQueuePatches(projectInput([queueClaim()]), database)
  const servingDelete = statements.find((statement) => {
    return statement.includes('DELETE FROM mart.review_unassessed_queue_serving_v4')
  })

  expect(servingDelete).not.toContain('review_config_hash IN')
  expect(servingDelete).toContain("article_id IN ('article-1')")
})

test('missing article-scoped queue inputs clear optional unassessed state without raw aggregation', async () => {
  const {database, statements} = createQueueDatabase()

  const result = await projectReviewServingQueuePatches(projectInput([queueClaim()]), database)
  const joined = statements.join('\n')

  expect(result).toEqual({patchRowCount: 0, patchWatermark: 14, servingRowCount: 0})
  expect(joined).not.toContain('mart.judgment_fact')
  expect(joined).not.toContain('app."judgment"')
  expect(joined).not.toContain('GROUP BY')
  expect(joined).toContain('DELETE FROM mart.review_unassessed_queue_serving_v4')
  expect(joined).toContain("article_id IN ('article-1')")
  expect(joined).not.toContain('review_config_hash IN')
})

test('missing prompt-scoped queue inputs clear stale prompt serving rows', async () => {
  const {database, statements} = createQueueDatabase()

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
  const joined = statements.join('\n')

  expect(result).toEqual({patchRowCount: 0, patchWatermark: 14, servingRowCount: 0})
  expect(joined).toContain('DELETE FROM mart.review_unassessed_queue_serving_v4')
  expect(joined).toContain("prompt_id IN ('prompt-1')")
  expect(joined).not.toContain('review_config_hash IN')
})

test('project-scoped empty queue rebuild clears snapshot serving rows', async () => {
  const {database, statements} = createQueueDatabase()

  const result = await projectReviewServingQueuePatches(
    projectInput([
      queueClaim({
        articleId: null,
        dirtyKind: 'project.reviewConfig.updated',
        scopeId: 'project-1',
        scopeKind: 'project',
      }),
    ]),
    database,
  )
  const servingDelete = statements.find((statement) => {
    return statement.includes('DELETE FROM mart.review_unassessed_queue_serving_v4')
  })

  expect(result).toEqual({patchRowCount: 0, patchWatermark: 14, servingRowCount: 0})
  expect(servingDelete).toContain("project_id = 'project-1'")
  expect(servingDelete).toContain("snapshot_id = 'snapshot-1'")
  expect(servingDelete).not.toContain('review_config_hash IN')
  expect(servingDelete).not.toContain('article_id IN')
  expect(servingDelete).not.toContain('prompt_id IN')
})
