import {expect, test} from 'bun:test'

import {type ReviewServingDirtyWorkClaim} from './reviewServingDirtyWorkService.ts'
import {
  projectReviewServingDisplayBaseRows,
  projectReviewServingDisplayPatches,
  projectReviewServingPayloadRanges,
  projectReviewServingPayloadRows,
  type ReviewServingDisplayPayloadProjectorDatabase,
} from './reviewServingDisplayPayloadProjector.ts'

const createDisplayPayloadDatabase = (input?: {
  displayBaseRows?: readonly Record<string, unknown>[]
  displayPatchRows?: readonly Record<string, unknown>[]
  payloadRows?: readonly Record<string, unknown>[]
}) => {
  const statements: string[] = []
  const database: ReviewServingDisplayPayloadProjectorDatabase = {
    queryJson: async <T>(statement: string) => {
      statements.push(statement)

      if (statement.includes('FROM app.review_source_change_outbox')) {
        return [] as T[]
      }

      if (statement.includes('LEFT JOIN app."article" article')) {
        return (input?.displayPatchRows ?? []) as T[]
      }

      if (statement.includes('ORDER BY article.article_created_at ASC NULLS LAST, scope.article_id ASC')) {
        return (input?.payloadRows ?? []) as T[]
      }

      if (statement.includes('LEFT JOIN app.review_selected_article_import_v4 selected')) {
        return (input?.displayBaseRows ?? []) as T[]
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

const displayClaim = (input?: Partial<ReviewServingDirtyWorkClaim>): ReviewServingDirtyWorkClaim => {
  return {
    articleId: 'article-1',
    dirtyKind: 'article.display.updated',
    dirtyRangeEnd: null,
    dirtyRangeStart: null,
    dirtyWorkId: 'dirty-work-1',
    firstSourceHighWaterMark: 4,
    latestDeltaId: 'delta-1',
    latestSourceHighWaterMark: 6,
    projectId: 'project-1',
    projectionComponent: 'display',
    projectionIdentity: 'display:identity-1',
    scopeId: 'project-1:article-1',
    scopeKind: 'article',
    sourcePartition: 'review-change:article',
    status: 'running',
    ...input,
  }
}

test('display routine updates write component-narrow patches for only claimed articles', async () => {
  const {database, statements} = createDisplayPayloadDatabase({
    displayPatchRows: [
      {
        activitySortAt: '2026-01-02T00:00:00.000Z',
        articleCreatedAt: '2026-01-01T00:00:00.000Z',
        articleExternalId: 'NCT-1',
        articleId: 'article-1',
        articleTitle: 'Updated title',
        articleUpdatedAt: null,
        arxivId: '2401.00001',
        biorxivId: null,
        doi: '10.1000/example',
        fullTextConversionStatus: 'converted',
        fullTextFetchedAt: '2026-01-03T00:00:00.000Z',
        fullTextPdf: 'https://example.test/article-1.pdf',
        journalTitle: null,
        medrxivId: null,
        pmid: '12345',
        publicationYear: null,
        sourceMetadata: {covidence: {studyId: 'study-1'}},
        sortKey: '2026-01-01T00:00:00.000Z',
        tombstone: false,
        url: 'https://example.test/article-1',
      },
    ],
  })

  const result = await projectReviewServingDisplayPatches(
    {
      baseGeneration: 3,
      claims: [displayClaim()],
      definitionVersion: 'display-v4-test',
      displayIdentity: 'display:identity-1',
      projectId: 'project-1',
      projectScopeIdentity: 'projectScope:identity-1',
      projectionIdentity: 'display:identity-1',
      selectedImportSnapshotId: 'selected-import-snapshot-1',
      snapshotId: 'snapshot-1',
    },
    database,
  )
  const selectStatement = statements.find((statement) => {
    return statement.includes('WITH dirty_article(article_id)')
  })
  const insertStatement = statements.find((statement) => {
    return statement.includes('INSERT INTO mart.review_article_display_patch_v4')
  })
  const joined = statements.join('\n')
  const updateStatement = statements.find((statement) => {
    return statement.includes('UPDATE mart.review_article_serving_v4')
  })

  expect(result).toEqual({patchRowCount: 1, patchWatermark: 6})
  expect(selectStatement).toContain("VALUES ('article-1')")
  expect(selectStatement).toContain(
    'COALESCE(article.article_created_at, scope.article_created_at, current_timestamp) AS sortKey',
  )
  expect(selectStatement).toContain(
    'COALESCE(article.article_updated_at, scope.article_updated_at, article.article_created_at, scope.article_created_at, current_timestamp) AS activitySortAt',
  )
  expect(selectStatement).toContain('FROM dirty_article dirty')
  expect(selectStatement).toContain('LEFT JOIN mart.project_scope_article scope')
  expect(selectStatement).toContain('LEFT JOIN app.review_selected_article_import_v4 selected_base')
  expect(selectStatement).toContain('LEFT JOIN mart.review_selected_import_patch_v4 selected_patch')
  expect(selectStatement).toContain('LEFT JOIN app.article_import_route_source_record selected_source')
  expect(selectStatement).toContain('WHEN selected_patch.patch_watermark IS NOT NULL THEN selected_patch.article_title')
  expect(selectStatement).toContain('ELSE selected_base.article_title')
  expect(selectStatement).toContain('WHEN selected_patch.patch_watermark IS NOT NULL THEN selected_patch.external_id')
  expect(selectStatement).toContain('ELSE selected_base.external_id')
  expect(selectStatement).toContain(
    "COALESCE(json_extract_string(selected_source.raw_payload, '$.covidence.citation.url'), article.url) AS url",
  )
  expect(selectStatement).toContain(
    'WHEN selected_patch.patch_watermark IS NOT NULL THEN selected_patch.source_record_key',
  )
  expect(insertStatement).toContain(
    'ON CONFLICT(project_id, display_identity, base_generation, patch_watermark, article_id)',
  )
  expect(joined).toContain('INSERT INTO app.review_serving_dirty_work_ack')
  expect(joined).toContain('UPDATE mart.review_article_serving_v4')
  expect(joined).toContain("article_external_id = 'NCT-1'")
  expect(joined).toContain("article_created_at = '2026-01-01T00:00:00.000Z'")
  expect(joined).toContain('article_updated_at = NULL')
  expect(joined).toContain("article_title = 'Updated title'")
  expect(joined).toContain("arxiv_id = '2401.00001'")
  expect(joined).toContain("doi = '10.1000/example'")
  expect(joined).toContain("full_text_pdf = 'https://example.test/article-1.pdf'")
  expect(joined).toContain("full_text_fetched_at = '2026-01-03T00:00:00.000Z'")
  expect(joined).toContain("full_text_conversion_status = 'converted'")
  expect(joined).toContain("pmid = '12345'")
  expect(joined).not.toContain('source_metadata =')
  expect(joined).toContain("activity_sort_at = '2026-01-02T00:00:00.000Z'")
  expect(joined).toContain("snapshot_id = 'snapshot-1'")
  expect(joined).toContain("url = 'https://example.test/article-1'")
  expect(updateStatement).not.toContain('journal_title =')
  expect(updateStatement).not.toContain('publication_year =')
  expect(joined).toContain("'display'")
  expect(joined).not.toContain("'llmStatus'")
  expect(joined).not.toContain("'humanStatus'")
})

test('payload projection preserves prompt-preview ordering inputs and avoids import JSON paths', async () => {
  const {database, statements} = createDisplayPayloadDatabase({
    payloadRows: [
      {
        abstractText: 'Abstract preview',
        articleCreatedAt: '2026-01-01T00:00:00.000Z',
        articleId: 'article-1',
        fullTextPreview: 'Full text preview',
        payloadBytes: 34,
        sourceMetadata: {source: 'fixture'},
      },
    ],
  })

  const result = await projectReviewServingPayloadRows(
    {
      displayIdentity: 'display:identity-1',
      payloadIdentity: 'payload:identity-1',
      projectId: 'project-1',
      selectedImportSnapshotId: 'selected-import-snapshot-1',
      snapshotId: 'snapshot-1',
      baseGeneration: 1,
    },
    database,
  )
  const selectStatement = statements.find((statement) => {
    return statement.includes('ORDER BY article.article_created_at ASC NULLS LAST, scope.article_id ASC')
  })
  const insertStatement = statements.find((statement) => {
    return statement.includes('INSERT INTO mart.review_article_serving_payload_v4')
  })
  const joined = statements.join('\n')

  expect(result).toEqual({payloadRowCount: 1, patchWatermark: 0})
  expect(selectStatement).toContain('article.article_created_at AS articleCreatedAt')
  expect(selectStatement).toContain('json_merge_patch')
  expect(selectStatement).toContain('LEFT JOIN app.review_selected_article_import_v4 selected_base')
  expect(selectStatement).toContain('LEFT JOIN mart.review_selected_import_patch_v4 selected_patch')
  expect(selectStatement).toContain('LEFT JOIN app.article_import_route_source_record selected_source')
  expect(selectStatement).toContain("selected_base.selected_import_snapshot_id = 'selected-import-snapshot-1'")
  expect(selectStatement).toContain("selected_patch.selected_import_snapshot_id = 'selected-import-snapshot-1'")
  expect(selectStatement).toContain('FROM mart.review_selected_import_patch_v4 newer')
  expect(selectStatement).toContain(
    'WHEN selected_patch.patch_watermark IS NOT NULL THEN selected_patch.import_route_id',
  )
  expect(selectStatement).toContain(
    'WHEN selected_patch.patch_watermark IS NOT NULL THEN selected_patch.source_record_key',
  )
  expect(selectStatement).toContain('LEFT(article.article_summary, 2000) AS abstractText')
  expect(insertStatement).toContain('article_created_at')
  expect(insertStatement).toContain('payload_bytes')
  expect(joined).not.toContain('selected_scoped_article_import')
  expect(joined).not.toContain('payload_json')
})

test('payload rebuild ranges write payload rows with SQL-native range statements', async () => {
  const {database, statements} = createDisplayPayloadDatabase()

  const result = await projectReviewServingPayloadRanges(
    {
      ranges: [
        {
          baseGeneration: 1,
          chunkEndArticleId: 'article-050',
          chunkStartArticleId: 'article-001',
          displayIdentity: 'display:identity-1',
          payloadIdentity: 'payload:identity-1',
          projectId: 'project-1',
          selectedImportSnapshotId: 'selected-import-snapshot-1',
          snapshotId: 'snapshot-1',
        },
        {
          baseGeneration: 1,
          chunkEndArticleId: 'article-099',
          chunkStartArticleId: 'article-051',
          displayIdentity: 'display:identity-1',
          payloadIdentity: 'payload:identity-1',
          projectId: 'project-1',
          selectedImportSnapshotId: 'selected-import-snapshot-1',
          snapshotId: 'snapshot-1',
        },
      ],
    },
    database,
  )
  const joined = statements.join('\n')

  expect(result).toEqual({rangeCount: 2})
  expect(joined).toContain('DELETE FROM mart.review_article_serving_payload_v4')
  expect(joined).toContain('INSERT INTO mart.review_article_serving_payload_v4')
  expect(joined).toContain('WITH payload_source AS')
  expect(joined).toContain("scope.article_id >= 'article-001'")
  expect(joined).toContain("scope.article_id <= 'article-050'")
  expect(joined).toContain("scope.article_id >= 'article-051'")
  expect(joined).toContain("scope.article_id <= 'article-099'")
  expect(joined).toContain('ON CONFLICT(project_id, display_identity, payload_identity, snapshot_id, article_id)')
  expect(joined).not.toContain('VALUES (')
})

test('payload claimed updates delete stale rows for removed articles before inserting replacements', async () => {
  const {database, statements} = createDisplayPayloadDatabase({payloadRows: []})

  const result = await projectReviewServingPayloadRows(
    {
      baseGeneration: 1,
      claims: [displayClaim({dirtyKind: 'projectScope.article.removed'})],
      definitionVersion: 'payload-v4-test',
      displayIdentity: 'display:identity-1',
      payloadIdentity: 'payload:identity-1',
      projectId: 'project-1',
      projectionIdentity: 'payload:identity-1',
      selectedImportSnapshotId: 'selected-import-snapshot-1',
      snapshotId: 'snapshot-1',
    },
    database,
  )
  const deleteStatement = statements.find((statement) => {
    return statement.includes('DELETE FROM mart.review_article_serving_payload_v4')
  })

  expect(result).toEqual({payloadRowCount: 0, patchWatermark: 6})
  expect(deleteStatement).toContain("article_id IN ('article-1')")
  expect(deleteStatement).toContain('payload_identity')
})

test('project-scoped payload rebuilds read scoped articles and clear snapshot payload rows', async () => {
  const {database, statements} = createDisplayPayloadDatabase({
    payloadRows: [
      {
        abstractText: 'Abstract preview',
        articleCreatedAt: '2026-01-01T00:00:00.000Z',
        articleId: 'article-2',
        fullTextPreview: 'Full text preview',
        payloadBytes: 34,
        sourceMetadata: {source: 'fixture'},
      },
    ],
  })

  const result = await projectReviewServingPayloadRows(
    {
      baseGeneration: 1,
      claims: [
        displayClaim({
          articleId: null,
          dirtyKind: 'project.reviewConfig.updated',
          projectionComponent: 'payload',
          scopeId: 'project-1',
          scopeKind: 'project',
        }),
      ],
      definitionVersion: 'payload-v4-test',
      displayIdentity: 'display:identity-1',
      payloadIdentity: 'payload:identity-1',
      projectId: 'project-1',
      projectionIdentity: 'payload:identity-1',
      selectedImportSnapshotId: 'selected-import-snapshot-1',
      snapshotId: 'snapshot-1',
    },
    database,
  )
  const selectStatement = statements.find((statement) => {
    return statement.includes('ORDER BY article.article_created_at ASC NULLS LAST, scope.article_id ASC')
  })
  const deleteStatement = statements.find((statement) => {
    return statement.includes('DELETE FROM mart.review_article_serving_payload_v4')
  })

  expect(result).toEqual({payloadRowCount: 1, patchWatermark: 6})
  expect(selectStatement).toContain('FROM mart.project_scope_article scope')
  expect(selectStatement).not.toContain('WITH dirty_article(article_id)')
  expect(selectStatement).not.toContain('INNER JOIN dirty_article dirty')
  expect(deleteStatement).toContain("project_id IS NOT DISTINCT FROM 'project-1'")
  expect(deleteStatement).toContain("snapshot_id IS NOT DISTINCT FROM 'snapshot-1'")
  expect(deleteStatement).toContain('payload_identity')
  expect(deleteStatement).not.toContain('article_id IN')
})

test('payload projection defers manifest and watermark when claims are not acknowledged', async () => {
  const {database, statements} = createDisplayPayloadDatabase({payloadRows: []})

  await projectReviewServingPayloadRows(
    {
      acknowledgeClaims: false,
      baseGeneration: 1,
      claims: [displayClaim({projectionComponent: 'payload'})],
      definitionVersion: 'payload-v4-test',
      displayIdentity: 'display:identity-1',
      payloadIdentity: 'payload:identity-1',
      projectId: 'project-1',
      projectionIdentity: 'payload:identity-1',
      selectedImportSnapshotId: 'selected-import-snapshot-1',
      snapshotId: 'snapshot-1',
    },
    database,
  )
  const joined = statements.join('\n')

  expect(joined).not.toContain('INSERT INTO app.review_projection_identity_manifest')
  expect(joined).not.toContain('INSERT INTO app.review_serving_projector_watermark')
  expect(joined).not.toContain('INSERT INTO app.review_serving_dirty_work_ack')
})

test('display base rows flow through writer with display fields and selected import hot projection', async () => {
  const {database, statements} = createDisplayPayloadDatabase({
    displayBaseRows: [
      {
        activitySortAt: '2026-01-02T00:00:00.000Z',
        articleCreatedAt: '2026-01-01T00:00:00.000Z',
        articleExternalId: 'external-1',
        articleId: 'article-1',
        articleTitle: 'Title',
        articleUpdatedAt: null,
        arxivId: null,
        biorxivId: null,
        conflictFlag: false,
        doi: '10.1000/example',
        duplicateFlag: false,
        fullTextConversionStatus: 'converted',
        fullTextFetchedAt: '2026-01-03T00:00:00.000Z',
        fullTextPdf: 'file.pdf',
        journalTitle: 'Journal',
        medrxivId: null,
        pmid: '12345',
        publicationYear: 2026,
        selectedImportRouteId: 'import-route-1',
        selectedRankKey: 'rank-1',
        sortKey: '2026-01-01T00:00:00.000Z',
        url: 'https://example.test/article-1',
      },
    ],
  })

  const result = await projectReviewServingDisplayBaseRows(
    {
      baseGeneration: 1,
      displayIdentity: 'display:identity-1',
      humanStatusIdentity: 'humanStatus:identity-1',
      listModeKeys: ['llm', 'human'],
      llmStatusIdentity: 'llmStatus:identity-1',
      payloadIdentity: 'payload:identity-1',
      postingIdentity: 'posting:identity-1',
      projectId: 'project-1',
      projectScopeIdentity: 'projectScope:identity-1',
      reviewConfigHash: 'review-config-1',
      selectedImportIdentity: 'selectedImport:identity-1',
      selectedImportSnapshotId: 'selected-import-snapshot-1',
      snapshotId: 'snapshot-1',
      summaryIdentity: 'summary:identity-1',
    },
    database,
  )
  const selectStatement = statements.find((statement) => {
    return statement.includes('LEFT JOIN app.review_selected_article_import_v4 selected_base')
  })
  const inserts = statements.filter((statement) => {
    return statement.includes('INSERT INTO mart.review_article_serving_v4')
  })
  const deletes = statements.filter((statement) => {
    return statement.includes('DELETE FROM mart.review_article_serving_v4')
  })

  expect(result).toEqual({rowCount: 2})
  expect(selectStatement).toContain('FROM mart.project_scope_article scope')
  expect(selectStatement).not.toContain('selected_scoped_article_import')
  expect(selectStatement).toContain('article.article_updated_at AS articleUpdatedAt')
  expect(selectStatement).toContain('article.doi')
  expect(selectStatement).toContain('article.full_text_fetched_at AS fullTextFetchedAt')
  expect(selectStatement).toContain('LEFT JOIN mart.review_selected_import_patch_v4 selected_patch')
  expect(selectStatement).toContain('FROM mart.review_selected_import_patch_v4 newer')
  expect(selectStatement).toContain('WHEN selected_patch.patch_watermark IS NOT NULL THEN selected_patch.article_title')
  expect(selectStatement).toContain('WHEN selected_patch.patch_watermark IS NOT NULL THEN selected_patch.external_id')
  expect(selectStatement).toContain(
    'WHEN selected_patch.patch_watermark IS NOT NULL THEN selected_patch.import_route_id',
  )
  expect(selectStatement).toContain(
    'WHEN selected_patch.patch_watermark IS NOT NULL THEN selected_patch.source_record_key',
  )
  expect(selectStatement).toContain('json_merge_patch')
  expect(deletes).toHaveLength(1)
  expect(deletes[0]).toContain("project_id = 'project-1'")
  expect(deletes[0]).toContain("review_config_hash = 'review-config-1'")
  expect(deletes[0]).toContain("snapshot_id = 'snapshot-1'")
  expect(deletes[0]).toContain("list_mode_key IN ('llm', 'human')")
  expect(deletes[0]).not.toContain('display_identity')
  expect(deletes[0]).not.toContain('base_generation')
  expect(inserts).toHaveLength(1)
  expect(inserts[0]).not.toContain('ON CONFLICT')
  expect(inserts[0]).toContain('WITH display_base AS')
  expect(inserts[0]).toContain('CROSS JOIN list_mode')
  expect(inserts[0]).not.toContain(') VALUES (\n      ')
  expect(inserts.join('\n')).toContain('article_title')
  expect(inserts.join('\n')).toContain('article_updated_at')
  expect(inserts.join('\n')).toContain('doi')
  expect(inserts.join('\n')).toContain('full_text_pdf')
  expect(inserts.join('\n')).toContain('full_text_fetched_at')
})
