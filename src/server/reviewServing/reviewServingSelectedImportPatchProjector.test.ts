import {expect, test} from 'bun:test'

import {type ReviewServingDirtyWorkClaim} from './reviewServingDirtyWorkService.ts'
import {
  checkReviewServingSelectedImportPatchBudget,
  projectReviewServingSelectedImportPatches,
  type ReviewServingSelectedImportPatchProjectorDatabase,
} from './reviewServingSelectedImportPatchProjector.ts'

const createSelectedImportPatchDatabase = (input?: {
  budgetRow?: {patchRows: number; patchWatermarks: number}
  patchRows?: readonly Record<string, unknown>[]
  snapshotRows?: readonly Record<string, unknown>[]
}) => {
  const statements: string[] = []
  const database: ReviewServingSelectedImportPatchProjectorDatabase = {
    queryJson: async <T>(statement: string) => {
      statements.push(statement)

      if (statement.includes('FROM app.review_source_change_outbox')) {
        return [] as T[]
      }

      if (statement.includes('COUNT(DISTINCT patch_watermark)')) {
        return [input?.budgetRow ?? {patchRows: 0, patchWatermarks: 0}] as T[]
      }

      if (statement.includes('FROM app.review_serving_snapshot_manifest')) {
        return (input?.snapshotRows ?? []) as T[]
      }

      return (input?.patchRows ?? []) as T[]
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

const selectedImportClaim = (input?: Partial<ReviewServingDirtyWorkClaim>): ReviewServingDirtyWorkClaim => {
  return {
    articleId: 'article-1',
    dirtyKind: 'importRoute.article.rankFields.updated',
    dirtyRangeEnd: null,
    dirtyRangeStart: null,
    dirtyWorkId: 'dirty-work-1',
    firstSourceHighWaterMark: 7,
    latestDeltaId: 'delta-1',
    latestSourceHighWaterMark: 9,
    projectId: 'project-1',
    projectionComponent: 'selectedImport',
    projectionIdentity: 'selectedImport:identity-1',
    scopeId: 'project-1:article-1',
    scopeKind: 'article',
    sourcePartition: 'import-run-article',
    status: 'running',
    ...input,
  }
}

const projectPatchInput = (claims: readonly ReviewServingDirtyWorkClaim[]) => {
  return {
    baseGeneration: 3,
    claims,
    definitionVersion: 'selected-import-v4-test',
    projectId: 'project-1',
    projectScopeIdentity: 'projectScope:identity-1',
    projectionIdentity: 'selectedImport:identity-1',
    selectedImportSnapshotId: 'selected-import-snapshot-1',
  }
}

test('selected-import routine updates write component-narrow patches for only claimed articles', async () => {
  const {database, statements} = createSelectedImportPatchDatabase({
    patchRows: [
      {
        articleId: 'article-1',
        conflictFlag: false,
        duplicateFlag: true,
        importRouteId: 'import-route-1',
        journalTitle: 'Selected Journal',
        publicationYear: 2026,
        selectedRankKey: '0001:article-1',
        selectedRankNumeric: 1,
        scopeTombstone: false,
        tombstone: false,
      },
    ],
  })

  const result = await projectReviewServingSelectedImportPatches(projectPatchInput([selectedImportClaim()]), database)
  const selectStatement = statements.find((statement) => {
    return statement.includes('WITH dirty_article(article_id)')
  })
  const insertStatement = statements.find((statement) => {
    return statement.includes('INSERT INTO mart.review_selected_import_patch_v4')
  })
  const joined = statements.join('\n')

  expect(result).toEqual({patchRowCount: 1, patchWatermark: 9})
  expect(selectStatement).toContain("VALUES ('article-1')")
  expect(selectStatement).toContain('FROM dirty_article dirty')
  expect(selectStatement).toContain('LEFT JOIN mart.project_scope_article scope')
  expect(selectStatement).toContain('INNER JOIN app.review_import_article_hot_field hot')
  expect(insertStatement).toContain('patch_watermark')
  expect(insertStatement).toContain('9')
  expect(insertStatement).toContain(
    'ON CONFLICT(project_id, project_scope_identity, selected_import_snapshot_id, patch_watermark, article_id)',
  )
  expect(joined).toContain('UPDATE mart.review_article_serving_v4 serving')
  expect(joined).toContain('INSERT INTO mart.review_article_serving_v4')
  expect(joined).toContain('serving_template AS')
  expect(joined).toContain('selected_import_route_id = changed.import_route_id')
  expect(joined).toContain('selected_rank_key = changed.selected_rank_key')
  expect(joined).toContain('journal_title = changed.journal_title')
  expect(joined).toContain("changed.journal_title")
})

test('selected-import tombstones replay idempotently with the same patch watermark and article key', async () => {
  const {database, statements} = createSelectedImportPatchDatabase({
    patchRows: [
      {
        articleId: 'article-1',
        conflictFlag: null,
        duplicateFlag: null,
        importRouteId: null,
        journalTitle: null,
        publicationYear: null,
        selectedRankKey: null,
        selectedRankNumeric: null,
        scopeTombstone: false,
        tombstone: true,
      },
    ],
  })

  await projectReviewServingSelectedImportPatches(projectPatchInput([selectedImportClaim()]), database)
  await projectReviewServingSelectedImportPatches(projectPatchInput([selectedImportClaim()]), database)

  const patchInserts = statements.filter((statement) => {
    return statement.includes('INSERT INTO mart.review_selected_import_patch_v4')
  })

  expect(patchInserts).toHaveLength(2)
  expect(patchInserts[0]).toContain('TRUE')
  expect(patchInserts[0]).toContain(
    'ON CONFLICT(project_id, project_scope_identity, selected_import_snapshot_id, patch_watermark, article_id)',
  )
  expect(patchInserts[1]).toContain(
    'ON CONFLICT(project_id, project_scope_identity, selected_import_snapshot_id, patch_watermark, article_id)',
  )
})

test('selected-import tombstones clear selected columns without deleting curated scoped articles', async () => {
  const {database, statements} = createSelectedImportPatchDatabase({
    patchRows: [
      {
        articleId: 'article-1',
        conflictFlag: null,
        duplicateFlag: null,
        importRouteId: null,
        journalTitle: null,
        publicationYear: null,
        selectedRankKey: null,
        selectedRankNumeric: null,
        scopeTombstone: false,
        tombstone: true,
      },
    ],
  })

  await projectReviewServingSelectedImportPatches(projectPatchInput([selectedImportClaim()]), database)
  const joined = statements.join('\n')

  expect(joined).toContain('changed.scope_tombstone = TRUE')
  expect(joined).toContain('changed.scope_tombstone = FALSE')
  expect(joined).toContain('selected_import_route_id = changed.import_route_id')
})

test('project-scoped selected-import rebuilds include previous serving articles for scope tombstones', async () => {
  const {database, statements} = createSelectedImportPatchDatabase({patchRows: []})

  await projectReviewServingSelectedImportPatches(
    projectPatchInput([
      selectedImportClaim({
        articleId: null,
        dirtyKind: 'project.reviewConfig.updated',
        scopeId: 'project-1',
        scopeKind: 'project',
      }),
    ]),
    database,
  )
  const selectStatement = statements.find((statement) => {
    return statement.includes('WITH dirty_article(article_id)')
  })

  expect(selectStatement).toContain('FROM mart.project_scope_article scope')
  expect(selectStatement).toContain('UNION')
  expect(selectStatement).toContain('FROM mart.review_article_serving_v4 serving')
  expect(selectStatement).toContain("serving.selected_import_identity = 'selectedImport:identity-1'")
  expect(selectStatement).toContain("snapshot.selected_import_snapshot_id = 'selected-import-snapshot-1'")
})

test('selected-import patches promote manifest and watermark atomically without unrelated component base generations', async () => {
  const {database, statements} = createSelectedImportPatchDatabase({patchRows: []})

  await projectReviewServingSelectedImportPatches(projectPatchInput([selectedImportClaim()]), database)

  const joined = statements.join('\n')

  expect(joined).toContain('INSERT INTO app.review_projection_identity_manifest')
  expect(joined).toContain("'selectedImport'")
  expect(joined).toContain('INSERT INTO app.review_serving_dirty_work_ack')
  expect(joined).toContain('INSERT INTO app.review_serving_projector_watermark')
  expect(joined).not.toContain("'display'")
  expect(joined).not.toContain("'projectScope'")
})

test('selected-import serving insert can seed rows from snapshot templates without existing serving rows', async () => {
  const {database, statements} = createSelectedImportPatchDatabase({
    patchRows: [
      {
        articleId: 'article-1',
        conflictFlag: false,
        duplicateFlag: false,
        importRouteId: 'import-route-1',
        journalTitle: 'Selected Journal',
        publicationYear: 2026,
        selectedRankKey: '0001:article-1',
        selectedRankNumeric: 1,
        scopeTombstone: false,
        tombstone: false,
      },
    ],
    snapshotRows: [
      {
        componentStateJson: JSON.stringify({
          optional: [],
          required: [
            {baseGeneration: '3', component: 'display', patchWatermark: '1', projectionIdentity: 'display:identity-1'},
            {
              baseGeneration: '3',
              component: 'projectScope',
              patchWatermark: '1',
              projectionIdentity: 'projectScope:identity-1',
            },
            {
              baseGeneration: '3',
              component: 'selectedImport',
              patchWatermark: '1',
              projectionIdentity: 'selectedImport:identity-1',
            },
            {baseGeneration: '3', component: 'llmStatus', patchWatermark: '1', projectionIdentity: 'llmStatus:identity-1'},
            {
              baseGeneration: '3',
              component: 'humanStatus',
              patchWatermark: '1',
              projectionIdentity: 'humanStatus:identity-1',
            },
            {baseGeneration: '3', component: 'posting', patchWatermark: '1', projectionIdentity: 'posting:identity-1'},
            {baseGeneration: '3', component: 'summary', patchWatermark: '1', projectionIdentity: 'summary:identity-1'},
            {baseGeneration: '3', component: 'payload', patchWatermark: '1', projectionIdentity: 'payload:identity-1'},
          ],
        }),
        reviewConfigHash: 'review-config-1',
        snapshotId: 'snapshot-1',
      },
    ],
  })

  await projectReviewServingSelectedImportPatches(projectPatchInput([selectedImportClaim()]), database)

  const servingInsert = statements.find((statement) => {
    return statement.includes('INSERT INTO mart.review_article_serving_v4')
  })

  expect(servingInsert).toContain('UNION')
  expect(servingInsert).toContain('review-config-1')
  expect(servingInsert).toContain('snapshot-1')
  expect(servingInsert).toContain('llmStatus:identity-1')
})

test('selected-import patch budget requests compaction when patch read cost exceeds thresholds', async () => {
  const {database, statements} = createSelectedImportPatchDatabase({budgetRow: {patchRows: 51, patchWatermarks: 3}})

  const result = await checkReviewServingSelectedImportPatchBudget(
    {
      maxPatchRows: 50,
      maxPatchWatermarks: 10,
      projectId: 'project-1',
      projectScopeIdentity: 'projectScope:identity-1',
      selectedImportSnapshotId: 'selected-import-snapshot-1',
    },
    database,
  )

  expect(result).toEqual({patchRows: 51, patchWatermarks: 3, shouldCompact: true})
  expect(statements.join('\n')).toContain('COUNT(DISTINCT patch_watermark)')
  expect(statements.join('\n')).toContain('FROM mart.review_selected_import_patch_v4')
})

test('project-scoped selected-import rebuilds all project scope articles', async () => {
  const {database, statements} = createSelectedImportPatchDatabase({patchRows: []})

  await projectReviewServingSelectedImportPatches(
    projectPatchInput([
      selectedImportClaim({
        articleId: null,
        dirtyKind: 'project.reviewConfig.updated',
        scopeId: 'project-1',
        scopeKind: 'project',
      }),
    ]),
    database,
  )
  const selectStatement = statements.find((statement) => {
    return statement.includes('WITH dirty_article(article_id)')
  })

  expect(selectStatement).toContain('FROM mart.project_scope_article scope')
  expect(selectStatement).toContain("scope.project_id = 'project-1'")
  expect(selectStatement).not.toContain("VALUES ('project-1')")
})
