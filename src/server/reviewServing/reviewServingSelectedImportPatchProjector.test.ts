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
  expect(selectStatement).toContain('INNER JOIN mart.project_scope_article scope')
  expect(selectStatement).toContain('INNER JOIN app.review_import_article_hot_field hot')
  expect(insertStatement).toContain('patch_watermark')
  expect(insertStatement).toContain('9')
  expect(insertStatement).toContain(
    'ON CONFLICT(project_id, project_scope_identity, selected_import_snapshot_id, patch_watermark, article_id)',
  )
  expect(joined).toContain('UPDATE mart.review_article_serving_v4 serving')
  expect(joined).toContain('selected_import_route_id = changed.import_route_id')
  expect(joined).toContain('selected_rank_key = changed.selected_rank_key')
})

test('selected-import tombstones replay idempotently with the same patch watermark and article key', async () => {
  const {database, statements} = createSelectedImportPatchDatabase({
    patchRows: [
      {
        articleId: 'article-1',
        conflictFlag: null,
        duplicateFlag: null,
        importRouteId: null,
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
