import {expect, test} from 'bun:test'

import {type ReviewServingDirtyWorkClaim} from './reviewServingDirtyWorkService.ts'
import {
  projectReviewServingDisplayBaseRanges,
  projectReviewServingDisplayBaseRows,
  projectReviewServingDisplayPatches,
  projectReviewServingPayloadRanges,
  projectReviewServingPayloadRows,
  type ReviewServingDisplayPayloadProjectorDatabase,
} from './reviewServingDisplayPayloadProjector.ts'

type ProjectorDiagnosticsResult = {diagnosticsJson: {phaseTimings: Record<string, number>}}

const getProjectorDiagnostics = (result: object) => {
  return (result as ProjectorDiagnosticsResult).diagnosticsJson
}

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

      if (statement.includes('ORDER BY scope.article_created_at ASC NULLS LAST, scope.article_id ASC')) {
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
  const joined = statements.join('\n')
  const updateStatement = statements.find((statement) => {
    return statement.includes('UPDATE mart.review_article_serving_v4')
  })

  expect(result).toEqual({patchRowCount: 0, patchWatermark: 6})
  expect(getProjectorDiagnostics(result).phaseTimings.sourceQueryMs).toBeGreaterThanOrEqual(0)
  expect(getProjectorDiagnostics(result).phaseTimings.recordTransformMs).toBeGreaterThanOrEqual(0)
  expect(getProjectorDiagnostics(result).phaseTimings.writerMs).toBeGreaterThanOrEqual(0)
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
  expect(selectStatement).toContain('LEFT JOIN app.review_import_article_hot_field selected_hot')
  expect(selectStatement).toContain('COALESCE(selected_base.tombstone, FALSE)')
  expect(selectStatement).toContain('selected_base.import_route_id')
  expect(selectStatement).toContain('selected_base.source_record_key')
  expect(selectStatement).not.toContain('mart.review_selected_import_patch_v4')
  expect(selectStatement).not.toContain('selected_patch')
  expect(selectStatement).toContain('LEFT JOIN app.article_import_route_source_record selected_source')
  expect(selectStatement).toContain('ELSE selected_hot.article_title')
  expect(selectStatement).toContain('ELSE selected_hot.external_id')
  expect(selectStatement).toContain('ELSE selected_hot.journal_title')
  expect(selectStatement).toContain('ELSE selected_hot.publication_year')
  expect(selectStatement).not.toContain('selected_base.article_title')
  expect(selectStatement).not.toContain('selected_base.external_id')
  expect(selectStatement).not.toContain('selected_base.journal_title')
  expect(selectStatement).not.toContain('selected_base.publication_year')
  expect(selectStatement).not.toContain('ELSE selected_base.duplicate_flag')
  expect(selectStatement).not.toContain('ELSE selected_base.conflict_flag')
  expect(selectStatement).toContain(
    "COALESCE(json_extract_string(selected_source.raw_payload, '$.covidence.citation.url'), article.url) AS url",
  )
  expect(selectStatement).not.toContain('json_merge_patch')
  expect(selectStatement).not.toContain('sourceMetadata')
  expect(joined).not.toContain('mart.review_article_display_patch_v4')
  expect(joined).toContain('INSERT INTO app.review_serving_dirty_work_ack')
  expect(joined).toContain('UPDATE mart.review_article_serving_v4')
  expect(joined).not.toContain("article_external_id = 'NCT-1'")
  expect(joined).toContain("article_created_at = '2026-01-01T00:00:00.000Z'")
  expect(joined).not.toContain('article_updated_at = NULL')
  expect(joined).not.toContain("article_title = 'Updated title'")
  expect(joined).not.toContain("arxiv_id = '2401.00001'")
  expect(joined).not.toContain("doi = '10.1000/example'")
  expect(joined).not.toContain('full_text_pdf =')
  expect(joined).not.toContain('full_text_fetched_at =')
  expect(joined).not.toContain('full_text_conversion_status =')
  expect(joined).not.toContain("pmid = '12345'")
  expect(joined).not.toContain('source_metadata =')
  expect(joined).toContain("activity_sort_at = '2026-01-02T00:00:00.000Z'")
  expect(joined).toContain("snapshot_id = 'snapshot-1'")
  expect(joined).not.toContain("url = 'https://example.test/article-1'")
  expect(updateStatement).not.toContain('journal_title =')
  expect(updateStatement).not.toContain('publication_year =')
  expect(joined).toContain("'display'")
  expect(joined).not.toContain("'llmStatus'")
  expect(joined).not.toContain("'humanStatus'")
})

test('display no-ack snapshot passes do not publish shared manifests or watermarks', async () => {
  const {database, statements} = createDisplayPayloadDatabase({displayPatchRows: []})

  await projectReviewServingDisplayPatches(
    {
      acknowledgeClaims: false,
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
  const joined = statements.join('\n')

  expect(joined).not.toContain('INSERT INTO app.review_projection_identity_manifest')
  expect(joined).not.toContain('INSERT INTO app.review_serving_projector_watermark')
  expect(joined).not.toContain('INSERT INTO app.review_serving_dirty_work_ack')
})

test('payload projection preserves prompt-preview ordering inputs and avoids import JSON paths', async () => {
  const {database, statements} = createDisplayPayloadDatabase({
    payloadRows: [
      {
        articleCreatedAt: '2026-01-01T00:00:00.000Z',
        articleId: 'article-1',
        fullTextPreview: 'Full text preview',
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
    return statement.includes('ORDER BY scope.article_created_at ASC NULLS LAST, scope.article_id ASC')
  })
  const insertStatement = statements.find((statement) => {
    return statement.includes('INSERT INTO mart.review_article_serving_payload_v4')
  })
  const joined = statements.join('\n')

  expect(result).toEqual({payloadRowCount: 1, patchWatermark: 0})
  expect(getProjectorDiagnostics(result).phaseTimings.sourceQueryMs).toBeGreaterThanOrEqual(0)
  expect(getProjectorDiagnostics(result).phaseTimings.recordTransformMs).toBeGreaterThanOrEqual(0)
  expect(getProjectorDiagnostics(result).phaseTimings.writerMs).toBeGreaterThanOrEqual(0)
  expect(selectStatement).not.toContain('article.article_created_at AS articleCreatedAt')
  expect(selectStatement).not.toContain('json_merge_patch')
  expect(selectStatement).not.toContain('sourceMetadata')
  expect(selectStatement).not.toContain('LEFT JOIN app.review_selected_article_import_v4 selected_base')
  expect(selectStatement).not.toContain('LEFT JOIN app.article_import_route_source_record selected_source')
  expect(selectStatement).not.toContain('LEFT JOIN app.review_import_article_hot_field selected_hot')
  expect(selectStatement).not.toContain("selected_base.selected_import_snapshot_id = 'selected-import-snapshot-1'")
  expect(selectStatement).not.toContain('mart.review_selected_import_patch_v4')
  expect(selectStatement).not.toContain('selected_patch')
  expect(selectStatement).not.toContain('LEFT(article.article_summary, 2000) AS abstractText')
  expect(selectStatement).not.toContain('article.article_summary')
  expect(selectStatement).not.toContain('article.article_updated_at AS articleUpdatedAt')
  expect(selectStatement).not.toContain('AS articleTitle')
  expect(selectStatement).not.toContain('AS articleExternalId')
  expect(selectStatement).not.toContain('article.full_text_pdf AS fullTextPdf')
  expect(selectStatement).not.toContain("length(COALESCE(article.full_text, ''))")
  expect(selectStatement).not.toContain('length(COALESCE(article.full_text_html')
  expect(selectStatement).not.toContain('AS payloadBytes')
  expect(insertStatement).not.toContain('article_created_at')
  expect(insertStatement).not.toContain('article_external_id')
  expect(insertStatement).not.toContain('article_title')
  expect(insertStatement).not.toContain('journal_title')
  expect(insertStatement).not.toContain('full_text_pdf')
  expect(insertStatement).not.toContain('payload_bytes')
  expect(insertStatement).not.toContain('source_metadata')
  expect(joined).not.toContain('selected_scoped_article_import')
  expect(joined).not.toContain('payload_json')
})

test('payload rebuild ranges insert payload rows idempotently with SQL-native range statements', async () => {
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
  const insertStatements = statements.filter((statement) => {
    return statement.includes('INSERT INTO mart.review_article_serving_payload_v4')
  })

  expect(result).toEqual({rangeCount: 2})
  expect(getProjectorDiagnostics(result).phaseTimings.writerMs).toBeGreaterThanOrEqual(0)
  expect(joined).not.toContain('DELETE FROM mart.review_article_serving_payload_v4')
  expect(insertStatements).toHaveLength(1)
  expect(joined).toContain('INSERT INTO mart.review_article_serving_payload_v4')
  expect(joined).toContain('payload_source AS')
  expect(joined).toContain('article_range_filter(chunk_start_article_id, chunk_end_article_id)')
  expect(joined).toContain("('article-001', 'article-050'), ('article-051', 'article-099')")
  expect(joined).not.toContain('abstract_text')
  expect(joined).not.toContain('full_text_preview')
  expect(joined).toContain('      payload_identity,\n      project_id,')
  expect(joined).not.toContain('payload_updated_at')
  expect(joined).toContain('      project_id,\n      snapshot_id')
  expect(joined).not.toContain('source_metadata')
  expect(joined).not.toContain('article_external_id')
  expect(joined).not.toContain('journal_title')
  expect(joined).not.toContain('full_text_pdf')
  expect(joined).toContain('ON CONFLICT(project_id, display_identity, payload_identity, snapshot_id, article_id)')
  expect(joined).toContain('DO NOTHING')
  expect(joined).not.toContain('DO UPDATE SET')
  expect(joined).not.toContain('payload_bytes = excluded.payload_bytes')
  expect(joined).not.toContain('mart.review_selected_import_patch_v4')
  expect(joined).not.toContain('selected_patch')
})

test('payload claimed updates avoid indexed deletes for removed article cleanup', async () => {
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
  const selectStatement = statements.find((statement) => {
    return statement.includes('ORDER BY scope.article_created_at ASC NULLS LAST, scope.article_id ASC')
  })
  const joined = statements.join('\n')

  expect(result).toEqual({payloadRowCount: 0, patchWatermark: 6})
  expect(selectStatement).not.toContain('mart.review_selected_import_patch_v4')
  expect(selectStatement).not.toContain('selected_patch')
  expect(joined).not.toContain('DELETE FROM mart.review_article_serving_payload_v4')
})

test('project-scoped payload rebuilds read scoped articles and avoid indexed payload deletes', async () => {
  const {database, statements} = createDisplayPayloadDatabase({
    payloadRows: [
      {
        articleCreatedAt: '2026-01-01T00:00:00.000Z',
        articleId: 'article-2',
        fullTextPreview: 'Full text preview',
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
    return statement.includes('ORDER BY scope.article_created_at ASC NULLS LAST, scope.article_id ASC')
  })
  const joined = statements.join('\n')

  expect(result).toEqual({payloadRowCount: 1, patchWatermark: 6})
  expect(selectStatement).toContain('FROM mart.project_scope_article scope')
  expect(selectStatement).not.toContain('WITH dirty_article(article_id)')
  expect(selectStatement).not.toContain('INNER JOIN dirty_article dirty')
  expect(joined).not.toContain('DELETE FROM mart.review_article_serving_payload_v4')
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
  expect(selectStatement).toContain('LEFT JOIN app.review_import_article_hot_field selected_hot')
  expect(selectStatement).toContain('COALESCE(selected_base.tombstone, FALSE)')
  expect(selectStatement).toContain('selected_base.import_route_id')
  expect(selectStatement).toContain('selected_base.source_record_key')
  expect(selectStatement).toContain('selected_base.selected_rank_key')
  expect(selectStatement).toContain('ELSE selected_hot.article_title')
  expect(selectStatement).toContain('ELSE selected_hot.external_id')
  expect(selectStatement).toContain('ELSE selected_hot.journal_title')
  expect(selectStatement).toContain('ELSE selected_hot.publication_year')
  expect(selectStatement).toContain('ELSE COALESCE(selected_hot.duplicate_flag, FALSE)')
  expect(selectStatement).toContain('ELSE COALESCE(selected_hot.conflict_flag, FALSE)')
  expect(selectStatement).not.toContain('selected_base.article_title')
  expect(selectStatement).not.toContain('selected_base.external_id')
  expect(selectStatement).not.toContain('selected_base.journal_title')
  expect(selectStatement).not.toContain('selected_base.publication_year')
  expect(selectStatement).not.toContain('selected_base.duplicate_flag')
  expect(selectStatement).not.toContain('selected_base.conflict_flag')
  expect(selectStatement).not.toContain('ELSE selected_base.duplicate_flag')
  expect(selectStatement).not.toContain('ELSE selected_base.conflict_flag')
  expect(selectStatement).toContain('article.article_updated_at AS articleUpdatedAt')
  expect(selectStatement).toContain('article.doi')
  expect(selectStatement).not.toContain('article.full_text_fetched_at AS fullTextFetchedAt')
  expect(selectStatement).not.toContain('article.full_text_pdf AS fullTextPdf')
  expect(selectStatement).not.toContain('article.full_text_conversion_status AS fullTextConversionStatus')
  expect(selectStatement).not.toContain('mart.review_selected_import_patch_v4')
  expect(selectStatement).not.toContain('selected_patch')
  expect(selectStatement).not.toContain('json_merge_patch')
  expect(selectStatement).not.toContain('sourceMetadata')
  expect(selectStatement).toContain(
    "COALESCE(json_extract_string(selected_source.raw_payload, '$.covidence.citation.url'), article.url) AS url",
  )
  expect(deletes).toHaveLength(0)
  expect(inserts).toHaveLength(1)
  expect(inserts[0]).toContain('ON CONFLICT(project_id, review_config_hash, snapshot_id, list_mode_key, article_id)')
  expect(inserts[0]).toContain('DO NOTHING')
  expect(inserts[0]).not.toContain('DO UPDATE SET')
  expect(inserts[0]).not.toContain('base_generation = excluded.base_generation')
  expect(inserts[0]).not.toContain('patch_watermark = excluded.patch_watermark')
  expect(inserts[0]).not.toContain('llm_status_key = excluded.llm_status_key')
  expect(inserts[0]).not.toContain('human_status_key = excluded.human_status_key')
  expect(inserts[0]).not.toContain('review_opened')
  expect(inserts[0]).not.toContain('review_sections_completed')
  expect(inserts[0]).not.toContain('mart.review_selected_import_patch_v4')
  expect(inserts[0]).not.toContain('selected_patch')
  expect(inserts[0]).toContain('WITH display_base AS')
  expect(inserts[0]).toContain('CROSS JOIN list_mode')
  expect(inserts[0]).not.toContain(') VALUES (\n      ')
  const insertTargetSql = inserts[0]?.split('WITH display_base AS')[0] ?? ''

  expect(insertTargetSql).not.toContain('article_title')
  expect(insertTargetSql).not.toContain('article_updated_at')
  expect(insertTargetSql).not.toContain('publication_year')
  expect(insertTargetSql).not.toContain('duplicate_flag')
  expect(insertTargetSql).not.toContain('conflict_flag')
  expect(insertTargetSql).not.toContain('doi')
  expect(inserts.join('\n')).not.toContain('full_text_pdf')
  expect(inserts.join('\n')).not.toContain('full_text_fetched_at')
  expect(inserts.join('\n')).not.toContain('full_text_conversion_status')
})

test('display base range rebuilds insert candidate rows without indexed serving updates', async () => {
  const {database, statements} = createDisplayPayloadDatabase()

  const result = await projectReviewServingDisplayBaseRanges(
    {
      ranges: [
        {
          baseGeneration: 1,
          chunkEndArticleId: 'article-050',
          chunkStartArticleId: 'article-001',
          displayIdentity: 'display:identity-1',
          humanStatusIdentity: 'humanStatus:identity-1',
          listModeKeys: ['llm'],
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
        {
          baseGeneration: 1,
          chunkEndArticleId: 'article-099',
          chunkStartArticleId: 'article-051',
          displayIdentity: 'display:identity-1',
          humanStatusIdentity: 'humanStatus:identity-1',
          listModeKeys: ['llm'],
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
      ],
    },
    database,
  )
  const joined = statements.join('\n')

  expect(result).toEqual({rangeCount: 2})
  expect(getProjectorDiagnostics(result).phaseTimings.writerMs).toBeGreaterThanOrEqual(0)
  expect(joined).not.toContain('DELETE FROM mart.review_article_serving_v4')
  expect(joined).toContain('INSERT INTO mart.review_article_serving_v4')
  expect(joined).toContain("scope.article_id >= 'article-001'")
  expect(joined).toContain("scope.article_id <= 'article-050'")
  expect(joined).toContain("scope.article_id >= 'article-051'")
  expect(joined).toContain("scope.article_id <= 'article-099'")
  expect(joined).toContain('ON CONFLICT(project_id, review_config_hash, snapshot_id, list_mode_key, article_id)')
  expect(joined).toContain('DO NOTHING')
  expect(joined).not.toContain('DO UPDATE SET')
  expect(joined).not.toContain('article_title = excluded.article_title')
  expect(joined).not.toContain('selected_import_route_id = excluded.selected_import_route_id')
  expect(joined).not.toContain('llm_status_key = excluded.llm_status_key')
  expect(joined).not.toContain('human_status_key = excluded.human_status_key')
  expect(joined).not.toContain('mart.review_selected_import_patch_v4')
  expect(joined).not.toContain('selected_patch')
})

test('display base rebuilds emit no stale row deletion statement', async () => {
  const {database, statements} = createDisplayPayloadDatabase()

  await projectReviewServingDisplayBaseRanges(
    {
      ranges: [
        {
          baseGeneration: 1,
          chunkEndArticleId: 'article-050',
          chunkStartArticleId: 'article-001',
          displayIdentity: 'display:identity-1',
          humanStatusIdentity: 'humanStatus:identity-1',
          listModeKeys: ['llm'],
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
      ],
    },
    database,
  )
  const joined = statements.join('\n')

  // This hardening slice is statement-shape only: stale row cleanup remains a
  // future semantic cleanup path, separate from avoiding indexed scoped mutation.
  expect(joined).toContain('ON CONFLICT(project_id, review_config_hash, snapshot_id, list_mode_key, article_id)')
  expect(joined).toContain('DO NOTHING')
  expect(joined).not.toContain('DO UPDATE SET')
  expect(joined).not.toContain('DELETE FROM mart.review_article_serving_v4')
  expect(joined).not.toContain('NOT EXISTS')
  expect(joined).not.toContain('stale')
})
