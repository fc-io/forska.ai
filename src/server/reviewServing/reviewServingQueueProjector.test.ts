import {expect, test} from 'bun:test'

import {type ReviewServingDirtyWorkClaim} from './reviewServingDirtyWorkService.ts'
import {
  projectReviewServingQueuePatches,
  projectReviewServingQueueRebuildRows,
  type ReviewServingQueueProjectorDatabase,
} from './reviewServingQueueProjector.ts'

const createQueueDatabase = (input?: {
  projectScopeChunkRanges?: readonly Record<string, unknown>[]
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

      if (statement.includes('queue_source_budget AS')) {
        return (input?.projectScopeChunkRanges ?? []) as T[]
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
  const articleRankDelete = statements.find((statement) => {
    return statement.includes('DELETE FROM mart.review_unassessed_queue_article_rank_serving_v4')
  })

  expect(result).toEqual({patchRowCount: 0, patchWatermark: 14, servingRowCount: 0})
  expect(joined).not.toContain('mart.review_queue_patch_v4')
  expect(joined).not.toContain('mart.review_llm_status_patch_v4')
  expect(joined).not.toContain('mart.review_human_status_patch_v4')
  expect(joined).not.toContain('mart.review_selected_import_patch_v4')
  expect(joined).not.toContain('mart.review_unassessed_queue_serving_v4')
  expect(articleRankDelete).toContain("article_id IN ('article-1')")
})

test('queue projector emits phase-start diagnostics before source SELECT and writer mutations', async () => {
  const {database, statements} = createQueueDatabase({queueRows: [queueRow()], reviewConfigHash: 'review-config-1'})
  const phaseEvents: string[] = []

  const result = await projectReviewServingQueuePatches(
    {
      ...projectInput([queueClaim()]),
      onPhaseStart: (event) => {
        phaseEvents.push(event.phase)
        statements.push(`phase:${event.phase}`)
      },
    },
    database,
  )
  const sourcePhaseIndex = statements.findIndex((statement) => {
    return statement === 'phase:sourceQuery'
  })
  const sourceSelectIndex = statements.findIndex((statement) => {
    return statement.includes('FROM queue_union queue')
  })
  const writerPhaseIndex = statements.findIndex((statement) => {
    return statement === 'phase:writer'
  })
  const deleteIndex = statements.findIndex((statement) => {
    return statement.includes('DELETE FROM mart.review_unassessed_queue_article_rank_serving_v4')
  })
  const insertIndex = statements.findIndex((statement) => {
    return statement.includes('INSERT INTO mart.review_unassessed_queue_article_rank_serving_v4')
  })

  expect(result.servingRowCount).toBe(1)
  expect(phaseEvents).toEqual(['sourceQuery', 'writer'])
  expect(sourcePhaseIndex).toBeGreaterThanOrEqual(0)
  expect(sourcePhaseIndex).toBeLessThan(sourceSelectIndex)
  expect(writerPhaseIndex).toBeGreaterThanOrEqual(0)
  expect(writerPhaseIndex).toBeLessThan(deleteIndex)
  expect(writerPhaseIndex).toBeLessThan(insertIndex)
})

test('queue no-ack snapshot passes do not publish shared manifests or watermarks', async () => {
  const {database, statements} = createQueueDatabase({queueRows: [queueRow()]})

  await projectReviewServingQueuePatches({...projectInput([queueClaim()]), acknowledgeClaims: false}, database)
  const joined = statements.join('\n')

  expect(joined).not.toContain('INSERT INTO app.review_projection_identity_manifest')
  expect(joined).not.toContain('INSERT INTO app.review_serving_projector_watermark')
  expect(joined).not.toContain('INSERT INTO app.review_serving_dirty_work_ack')
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
  const articleRankInsert = statements.find((statement) => {
    return statement.includes('INSERT INTO mart.review_unassessed_queue_article_rank_serving_v4')
  })
  const queueSelect = statements.find((statement) => {
    return statement.includes('FROM queue_union queue')
  })

  expect(result).toEqual({patchRowCount: 0, patchWatermark: 14, servingRowCount: 1})
  expect(statements.join('\n')).not.toContain('mart.review_queue_patch_v4')
  expect(statements.join('\n')).not.toContain('mart.review_unassessed_queue_serving_v4')
  expect(articleRankInsert).toContain('mart.review_unassessed_queue_article_rank_serving_v4')
  expect(queueSelect).not.toContain("OR queue.prompt_id = 'summary'")
  expect(queueSelect?.match(/queue_union AS/g) ?? []).toHaveLength(1)
})

test('summary-mode queue rebuild keeps imported Covidence summary rows with empty answers reviewable', async () => {
  const {database, statements} = createQueueDatabase({
    queueRows: [queueRow({promptId: 'summary', queueKind: 'human-unreviewed'})],
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

  expect(result).toEqual({patchRowCount: 0, patchWatermark: 14, servingRowCount: 1})
  expect(queueSelect).not.toContain("judgment_human_summary.origin = 'covidence_import'")
  expect(queueSelect).toContain(
    "NULLIF(TRIM(COALESCE(judgment_human.answer, judgment_human_summary.answer, '')), '') IS NOT NULL AS tombstone",
  )
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
    return statement.includes('INSERT INTO mart.review_unassessed_queue_article_rank_serving_v4')
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
  const articleRankDelete = statements.find((statement) => {
    return statement.includes('DELETE FROM mart.review_unassessed_queue_article_rank_serving_v4')
  })

  expect(result).toEqual({patchRowCount: 0, patchWatermark: 14, servingRowCount: 0})
  expect(statements.join('\n')).not.toContain('mart.review_queue_patch_v4')
  expect(statements.join('\n')).not.toContain('mart.review_unassessed_queue_serving_v4')
  expect(articleRankDelete).not.toContain('article_id IN')
  expect(articleRankDelete).not.toContain('prompt_ids')
})

test('project-scoped queue dirty work runs bounded article chunks before acknowledging', async () => {
  const {database, statements} = createQueueDatabase({
    projectScopeChunkRanges: [
      {
        articleCount: 50,
        articleLimit: 50,
        chunkEndArticleId: 'article-050',
        chunkStartArticleId: 'article-001',
        estimatedSourceRowCount: 50_000,
        sourceFanout: 1_000,
      },
      {
        articleCount: 50,
        articleLimit: 50,
        chunkEndArticleId: 'article-100',
        chunkStartArticleId: 'article-050 ',
        estimatedSourceRowCount: 50_000,
        sourceFanout: 1_000,
      },
    ],
    queueRows: [queueRow({articleId: 'article-025'})],
    reviewConfigHash: 'review-config-1',
  })
  const phaseEvents: Array<{chunkIndex?: number; phase: string; sourceRowLimit?: number}> = []

  const result = await projectReviewServingQueuePatches(
    {
      ...projectInput([
        queueClaim({
          articleId: null,
          dirtyKind: 'project.reviewConfig.updated',
          scopeId: 'project-1',
          scopeKind: 'project',
        }),
      ]),
      onPhaseStart: (event) => {
        phaseEvents.push({chunkIndex: event.chunkIndex, phase: event.phase, sourceRowLimit: event.sourceRowLimit})
      },
    },
    database,
  )
  const joined = statements.join('\n')
  const sourceSelects = statements.filter((statement) => {
    return statement.includes('FROM queue_union queue')
  })
  const articleRankDeletes = statements.filter((statement) => {
    return statement.includes('DELETE FROM mart.review_unassessed_queue_article_rank_serving_v4')
  })
  const acknowledgements = statements.filter((statement) => {
    return statement.includes('INSERT INTO app.review_serving_dirty_work_ack') && statement.includes("'dirty-work-1'")
  })

  expect(result).toEqual({patchRowCount: 0, patchWatermark: 14, servingRowCount: 2})
  expect(joined).toContain('queue_source_budget AS')
  expect(joined).toContain('NTILE(article_plan.chunk_count) OVER (ORDER BY scoped_article.article_id)')
  expect(joined).toContain('FLOOR(50000 / GREATEST(1, enabled_prompt_count + human_prompt_count))')
  expect(joined).toContain("ELSE previous_scoped_end_key || ' '")
  expect(sourceSelects).toHaveLength(2)
  expect(sourceSelects[0]).toContain("scope.article_id >= 'article-001'")
  expect(sourceSelects[0]).toContain("scope.article_id <= 'article-050'")
  expect(sourceSelects[1]).toContain("scope.article_id >= 'article-050 '")
  expect(sourceSelects[1]).toContain("scope.article_id <= 'article-100'")
  expect(articleRankDeletes).toHaveLength(2)
  expect(articleRankDeletes[0]).toContain("article_id >= 'article-001'")
  expect(articleRankDeletes[0]).toContain("article_id <= 'article-050'")
  expect(articleRankDeletes[1]).toContain("article_id >= 'article-050 '")
  expect(articleRankDeletes[1]).toContain("article_id <= 'article-100'")
  expect(acknowledgements).toHaveLength(1)
  expect(phaseEvents).toEqual([
    {chunkIndex: 0, phase: 'sourceQuery', sourceRowLimit: 50_000},
    {chunkIndex: 0, phase: 'writer', sourceRowLimit: 50_000},
    {chunkIndex: 1, phase: 'sourceQuery', sourceRowLimit: 50_000},
    {chunkIndex: 1, phase: 'writer', sourceRowLimit: 50_000},
  ])
})

test('project-scoped queue dirty work without a snapshot skips project-scope chunk planning', async () => {
  const {database, statements} = createQueueDatabase({
    projectScopeChunkRanges: [
      {
        articleCount: 50,
        articleLimit: 50,
        chunkEndArticleId: 'article-050',
        chunkStartArticleId: 'article-001',
        estimatedSourceRowCount: 50_000,
        sourceFanout: 1_000,
      },
    ],
  })

  const result = await projectReviewServingQueuePatches(
    {
      ...projectInput([
        queueClaim({
          articleId: null,
          dirtyKind: 'project.reviewConfig.updated',
          scopeId: 'project-1',
          scopeKind: 'project',
        }),
      ]),
      snapshotId: null,
    },
    database,
  )
  const joined = statements.join('\n')

  expect(result).toEqual({patchRowCount: 0, patchWatermark: 14, servingRowCount: 0})
  expect(joined).not.toContain('queue_source_budget AS')
  expect(joined).not.toContain('FROM queue_union queue')
  expect(joined).toContain('INSERT INTO app.review_serving_dirty_work_ack')
})

test('queue rebuild rows do not let selected-import tombstones suppress scoped articles', async () => {
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
    return statement.includes('INSERT INTO mart.review_unassessed_queue_article_rank_serving_v4')
  })

  expect(insertStatement).not.toContain('review_selected_article_import_current_v4')
  expect(insertStatement).not.toContain('selected_tombstone')
  expect(insertStatement).toContain('scoped.scope_tombstone')
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
  expect(joined).toContain('WHERE NOT EXISTS')
  expect(joined).toContain("'queue'")
  expect(joined).not.toContain('FROM app."judgment"')
  expect(joined).not.toContain('FROM app."judgment_human"')
})

test('queue serving replacement deletes only projected review configs', async () => {
  const {database, statements} = createQueueDatabase({
    queueRows: [queueRow({reviewConfigHash: 'review-config-2'}), queueRow({reviewConfigHash: null})],
  })

  await projectReviewServingQueuePatches(projectInput([queueClaim()]), database)
  const articleRankDelete = statements.find((statement) => {
    return statement.includes('DELETE FROM mart.review_unassessed_queue_article_rank_serving_v4')
  })

  expect(statements.join('\n')).not.toContain('mart.review_unassessed_queue_serving_v4')
  expect(articleRankDelete).not.toContain('review_config_hash IN')
  expect(articleRankDelete).toContain("article_id IN ('article-1')")
})

test('missing article-scoped queue inputs clear optional unassessed state without raw aggregation', async () => {
  const {database, statements} = createQueueDatabase()

  const result = await projectReviewServingQueuePatches(projectInput([queueClaim()]), database)
  const joined = statements.join('\n')

  expect(result).toEqual({patchRowCount: 0, patchWatermark: 14, servingRowCount: 0})
  expect(joined).not.toContain('mart.judgment_fact')
  expect(joined).not.toContain('app."judgment"')
  expect(joined).not.toContain('GROUP BY judgment')
  expect(joined).not.toContain('mart.review_unassessed_queue_serving_v4')
  expect(joined).toContain('DELETE FROM mart.review_unassessed_queue_article_rank_serving_v4')
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
  expect(joined).not.toContain('mart.review_unassessed_queue_serving_v4')
  expect(joined).toContain('DELETE FROM mart.review_unassessed_queue_article_rank_serving_v4')
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
  const articleRankDelete = statements.find((statement) => {
    return statement.includes('DELETE FROM mart.review_unassessed_queue_article_rank_serving_v4')
  })

  expect(result).toEqual({patchRowCount: 0, patchWatermark: 14, servingRowCount: 0})
  expect(statements.join('\n')).not.toContain('mart.review_unassessed_queue_serving_v4')
  expect(articleRankDelete).toContain("project_id = 'project-1'")
  expect(articleRankDelete).toContain("snapshot_id = 'snapshot-1'")
  expect(articleRankDelete).not.toContain('review_config_hash IN')
  expect(articleRankDelete).not.toContain('article_id IN')
  expect(articleRankDelete).not.toContain('prompt_ids')
})
