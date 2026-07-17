import {expect, test} from 'bun:test'

import {type ReviewServingDirtyWorkClaim} from './reviewServingDirtyWorkService.ts'
import {
  checkReviewServingSelectedImportDirtyBudget,
  projectReviewServingSelectedImportDirty,
  resetReviewServingSelectedImportDirtyArticleRange,
  type ReviewServingSelectedImportDirtyProjectorDatabase,
} from './reviewServingSelectedImportDirtyProjector.ts'

const createSelectedImportDirtyDatabase = (input?: {
  budgetRow?: {dirtyRows: number; dirtyWatermarks: number}
  dirtyRows?: readonly Record<string, unknown>[]
  snapshotRows?: readonly Record<string, unknown>[]
}) => {
  const statements: string[] = []
  const database: ReviewServingSelectedImportDirtyProjectorDatabase = {
    queryJson: async <T>(statement: string) => {
      statements.push(statement)

      if (statement.includes('FROM app.review_source_change_outbox')) {
        return [] as T[]
      }

      if (statement.includes('COUNT(DISTINCT patch_watermark)')) {
        return [input?.budgetRow ?? {dirtyRows: 0, dirtyWatermarks: 0}] as T[]
      }

      if (statement.includes('FROM app.review_serving_snapshot_manifest')) {
        return (input?.snapshotRows ?? []) as T[]
      }

      return (input?.dirtyRows ?? []) as T[]
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

const projectDirtyInput = (claims: readonly ReviewServingDirtyWorkClaim[]) => {
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

test('selected-import dirty routine updates only claimed articles', async () => {
  const {database, statements} = createSelectedImportDirtyDatabase({
    dirtyRows: [
      {
        articleId: 'article-1',
        articleTitle: 'Selected Import Title',
        conflictFlag: false,
        duplicateFlag: true,
        externalId: 'selected-external-1',
        importRouteId: 'import-route-1',
        journalTitle: 'Selected Journal',
        publicationYear: 2026,
        selectedRankKey: '0001:article-1',
        selectedRankNumeric: 1,
        sourceRecordKey: 'source-record-1',
        selectedSourceUrl: 'https://selected.example/article-1',
        scopeTombstone: false,
        tombstone: false,
      },
    ],
  })

  const result = await projectReviewServingSelectedImportDirty(projectDirtyInput([selectedImportClaim()]), database)
  const selectStatement = statements.find((statement) => {
    return statement.includes('WITH dirty_article(article_id)')
  })
  const joined = statements.join('\n')

  expect(result).toEqual({dirtyRowCount: 1, dirtyWatermark: 9})
  expect(selectStatement).toContain("VALUES ('article-1')")
  expect(selectStatement).toContain('SELECT DISTINCT')
  expect(selectStatement).toContain('FROM dirty_article dirty')
  expect(selectStatement).toContain('LEFT JOIN mart.project_scope_article scope')
  expect(selectStatement).toContain('INNER JOIN app.review_import_article_hot_field hot')
  expect(selectStatement).toContain('LEFT JOIN app.article_import_route current_link')
  expect(selectStatement).toContain('ROW_NUMBER() OVER')
  expect(selectStatement).toContain('PARTITION BY candidate.article_id')
  expect(selectStatement).toContain('hot.article_title')
  expect(selectStatement).toContain('hot.external_id')
  expect(selectStatement).toContain('winner.source_record_key AS sourceRecordKey')
  expect(selectStatement).toContain('LEFT JOIN app.article_import_route_source_record selected_source')
  expect(selectStatement).toContain("json_extract_string(selected_source.raw_payload, '$.covidence.citation.url')")
  expect(selectStatement).toContain("WHEN current_link.id IS NOT NULL THEN concat('0:', hot.selected_rank_key)")
  expect(joined).not.toContain('mart.review_selected_import_patch_v4')
  expect(joined).toContain('CREATE OR REPLACE TEMP TABLE review_selected_import_serving_update_v4 AS')
  expect(joined).toContain('DELETE FROM mart.review_article_serving_v4 serving')
  expect(joined).toContain('INSERT INTO mart.review_article_serving_v4')
  expect(joined).toContain('INSERT INTO app.review_selected_article_import_v4')
  expect(joined).toContain('source_record_key')
  expect(joined).toContain('changed_raw(article_id, import_route_id, selected_rank_key')
  expect(joined).toContain('PARTITION BY raw.article_id')
  expect(joined).toContain('serving_template_raw AS')
  expect(joined).toContain('serving_template AS')
  expect(joined).toContain('PARTITION BY raw.project_id, raw.review_config_hash, raw.snapshot_id, raw.list_mode_key')
  expect(joined).toContain('FROM mart.review_article_serving_v4 existing')
  expect(joined).toContain('existing.article_id = changed.article_id')
  expect(joined).toContain('changed.import_route_id AS selected_import_route_id')
  expect(joined).toContain('changed.selected_rank_key')
  expect(joined).toContain('COALESCE(changed.article_title, article.article_title) AS article_title')
  expect(joined).toContain('COALESCE(changed.external_id, article.article_id) AS article_external_id')
  expect(joined).toContain('COALESCE(changed.selected_source_url, article.url) AS url')
  expect(joined).toContain('changed.journal_title')
})

test('selected-import projector advances watermark for the max source partition', async () => {
  const {database, statements} = createSelectedImportDirtyDatabase({dirtyRows: []})

  await projectReviewServingSelectedImportDirty(
    projectDirtyInput([
      selectedImportClaim({
        dirtyWorkId: 'dirty-work-import',
        firstSourceHighWaterMark: 7,
        latestSourceHighWaterMark: 7,
        sourcePartition: 'importRunArticle',
      }),
      selectedImportClaim({
        articleId: null,
        dirtyWorkId: 'dirty-work-review',
        firstSourceHighWaterMark: 9,
        latestSourceHighWaterMark: 9,
        scopeId: 'project-1',
        scopeKind: 'project',
        sourcePartition: 'reviewChange',
      }),
    ]),
    database,
  )
  const watermarkStatement = statements.find((statement) => {
    return (
      statement.includes('INSERT INTO app.review_serving_projector_watermark') && statement.includes('WHERE NOT EXISTS')
    )
  })

  expect(watermarkStatement).toContain("'reviewChange'")
  expect(watermarkStatement).toContain('9')
})

test('selected-import no-ack snapshot passes do not publish shared manifests or watermarks', async () => {
  const {database, statements} = createSelectedImportDirtyDatabase({dirtyRows: []})

  await projectReviewServingSelectedImportDirty(
    {...projectDirtyInput([selectedImportClaim()]), acknowledgeClaims: false},
    database,
  )

  const joined = statements.join('\n')

  expect(joined).not.toContain('INSERT INTO app.review_projection_identity_manifest')
  expect(joined).not.toContain('INSERT INTO app.review_serving_dirty_work_ack')
  expect(joined).not.toContain('INSERT INTO app.review_serving_projector_watermark')
})

test('selected-import projector keeps explicit manifest watermarks separate from dirty watermarks', async () => {
  const {database, statements} = createSelectedImportDirtyDatabase({
    dirtyRows: [
      {
        articleId: 'article-1',
        articleTitle: 'Selected Import Title',
        conflictFlag: false,
        duplicateFlag: false,
        externalId: 'selected-external-1',
        importRouteId: 'import-route-1',
        journalTitle: null,
        publicationYear: null,
        selectedRankKey: '0001:article-1',
        selectedRankNumeric: 1,
        sourceRecordKey: 'source-record-1',
        selectedSourceUrl: null,
        scopeTombstone: false,
        tombstone: false,
      },
    ],
  })

  const result = await projectReviewServingSelectedImportDirty(
    {
      ...projectDirtyInput([
        selectedImportClaim({
          firstSourceHighWaterMark: 7,
          latestSourceHighWaterMark: 7,
          sourcePartition: 'importRunArticle',
        }),
      ]),
      manifestInputWatermarks: {importRunArticle: 7, reviewChange: 9},
    },
    database,
  )
  const manifestStatement = statements.find((statement) => {
    return (
      statement.includes('INSERT INTO app.review_projection_identity_manifest')
      || statement.includes('UPDATE app.review_projection_identity_manifest')
    )
  })

  expect(result).toEqual({dirtyRowCount: 1, dirtyWatermark: 7})
  expect(statements.join('\n')).not.toContain('mart.review_selected_import_patch_v4')
  expect(manifestStatement).toContain('\'{"importRunArticle":7,"reviewChange":9}\'::JSON')
})

test('selected-import tombstones replay idempotently with the same dirty watermark and article key', async () => {
  const {database, statements} = createSelectedImportDirtyDatabase({
    dirtyRows: [
      {
        articleId: 'article-1',
        articleTitle: null,
        conflictFlag: null,
        duplicateFlag: null,
        externalId: null,
        importRouteId: null,
        journalTitle: null,
        publicationYear: null,
        selectedRankKey: null,
        selectedRankNumeric: null,
        sourceRecordKey: null,
        selectedSourceUrl: null,
        scopeTombstone: false,
        tombstone: true,
      },
    ],
  })

  await projectReviewServingSelectedImportDirty(projectDirtyInput([selectedImportClaim()]), database)
  await projectReviewServingSelectedImportDirty(projectDirtyInput([selectedImportClaim()]), database)

  expect(statements.join('\n')).not.toContain('mart.review_selected_import_patch_v4')
})

test('selected-import tombstones clear selected columns without deleting curated scoped articles', async () => {
  const {database, statements} = createSelectedImportDirtyDatabase({
    dirtyRows: [
      {
        articleId: 'article-1',
        articleTitle: null,
        conflictFlag: null,
        duplicateFlag: null,
        externalId: null,
        importRouteId: null,
        journalTitle: null,
        publicationYear: null,
        selectedRankKey: null,
        selectedRankNumeric: null,
        sourceRecordKey: null,
        selectedSourceUrl: null,
        scopeTombstone: false,
        tombstone: true,
      },
    ],
  })

  await projectReviewServingSelectedImportDirty(projectDirtyInput([selectedImportClaim()]), database)
  const joined = statements.join('\n')

  expect(joined).toContain('changed.scope_tombstone = TRUE')
  expect(joined).toContain('changed.scope_tombstone = FALSE')
  expect(joined).toContain('changed.import_route_id AS selected_import_route_id')
})

test('project-scoped selected-import rebuilds include previous serving articles for scope tombstones', async () => {
  const {database, statements} = createSelectedImportDirtyDatabase({dirtyRows: []})

  await projectReviewServingSelectedImportDirty(
    projectDirtyInput([
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

test('selected-import dirty projection promotes manifest and watermark atomically without unrelated component base generations', async () => {
  const {database, statements} = createSelectedImportDirtyDatabase({dirtyRows: []})

  await projectReviewServingSelectedImportDirty(projectDirtyInput([selectedImportClaim()]), database)

  const joined = statements.join('\n')

  expect(joined).toContain('INSERT INTO app.review_projection_identity_manifest')
  expect(joined).toContain("'selectedImport'")
  expect(joined).toContain('INSERT INTO app.review_serving_dirty_work_ack')
  expect(joined).toContain('INSERT INTO app.review_serving_projector_watermark')
  expect(joined).toContain('WHERE NOT EXISTS')
  expect(joined).not.toContain("'display'")
  expect(joined).not.toContain("'projectScope'")
})

test('selected-import serving insert can seed rows from snapshot templates without existing serving rows', async () => {
  const {database, statements} = createSelectedImportDirtyDatabase({
    dirtyRows: [
      {
        articleId: 'article-1',
        articleTitle: 'Selected Import Title',
        conflictFlag: false,
        duplicateFlag: false,
        externalId: 'selected-external-1',
        importRouteId: 'import-route-1',
        journalTitle: 'Selected Journal',
        publicationYear: 2026,
        selectedRankKey: '0001:article-1',
        selectedRankNumeric: 1,
        sourceRecordKey: 'source-record-1',
        selectedSourceUrl: 'https://selected.example/article-1',
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
            {
              baseGeneration: '3',
              component: 'llmStatus',
              patchWatermark: '1',
              projectionIdentity: 'llmStatus:identity-1',
            },
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

  await projectReviewServingSelectedImportDirty(projectDirtyInput([selectedImportClaim()]), database)

  const servingInsert = statements.find((statement) => {
    return statement.includes('INSERT INTO mart.review_article_serving_v4')
  })

  expect(servingInsert).toContain('UNION')
  expect(servingInsert).not.toContain('source_metadata')
  expect(servingInsert).toContain('review-config-1')
  expect(servingInsert).toContain('snapshot-1')
  expect(servingInsert).toContain('llmStatus:identity-1')
})

test('selected-import dirty budget is a no-op without legacy runtime patch reads', async () => {
  const {database, statements} = createSelectedImportDirtyDatabase({budgetRow: {dirtyRows: 51, dirtyWatermarks: 3}})

  const result = await checkReviewServingSelectedImportDirtyBudget(
    {
      maxDirtyRows: 50,
      maxDirtyWatermarks: 10,
      projectId: 'project-1',
      projectScopeIdentity: 'projectScope:identity-1',
      selectedImportSnapshotId: 'selected-import-snapshot-1',
    },
    database,
  )

  expect(result).toEqual({dirtyRows: 0, dirtyWatermarks: 0, shouldCompact: false})
  expect(statements.join('\n')).not.toContain('mart.review_selected_import_patch_v4')
})

test('selected-import dirty article-range reset is a no-op without legacy patch rows', async () => {
  const {database, statements} = createSelectedImportDirtyDatabase()

  await resetReviewServingSelectedImportDirtyArticleRange(
    {
      chunkEndArticleId: 'article-099',
      chunkStartArticleId: 'article-050',
      projectId: 'project-1',
      projectScopeIdentity: 'projectScope:identity-1',
      selectedImportSnapshotId: 'selected-import-snapshot-1',
    },
    database,
  )
  const joined = statements.join('\n')

  expect(joined).not.toContain('mart.review_selected_import_patch_v4')
})

test('project-scoped selected-import rebuilds all project scope articles', async () => {
  const {database, statements} = createSelectedImportDirtyDatabase({dirtyRows: []})

  await projectReviewServingSelectedImportDirty(
    projectDirtyInput([
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
