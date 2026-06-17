import {expect, test} from 'bun:test'

import {type ReviewServingDirtyWorkClaim} from './reviewServingDirtyWorkService.ts'
import {
  projectReviewServingDisplayBaseRows,
  projectReviewServingDisplayPatches,
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
        articleExternalId: 'NCT-1',
        articleId: 'article-1',
        articleTitle: 'Updated title',
        journalTitle: null,
        publicationYear: null,
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

  expect(result).toEqual({patchRowCount: 1, patchWatermark: 6})
  expect(selectStatement).toContain("VALUES ('article-1')")
  expect(selectStatement).toContain('FROM dirty_article dirty')
  expect(selectStatement).toContain('LEFT JOIN app.review_selected_article_import_v4 selected')
  expect(insertStatement).toContain(
    'ON CONFLICT(project_id, display_identity, base_generation, patch_watermark, article_id)',
  )
  expect(joined).toContain('INSERT INTO app.review_serving_dirty_work_ack')
  expect(joined).toContain('UPDATE mart.review_article_serving_v4')
  expect(joined).toContain("article_title = 'Updated title'")
  expect(joined).toContain("url = 'https://example.test/article-1'")
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
  expect(selectStatement).toContain('article.source_metadata AS sourceMetadata')
  expect(selectStatement).toContain('LEFT(article.article_summary, 2000) AS abstractText')
  expect(insertStatement).toContain('article_created_at')
  expect(insertStatement).toContain('payload_bytes')
  expect(joined).not.toContain('selected_scoped_article_import')
  expect(joined).not.toContain('payload_json')
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

test('display base rows flow through writer with display fields and selected import hot projection', async () => {
  const {database, statements} = createDisplayPayloadDatabase({
    displayBaseRows: [
      {
        activitySortAt: '2026-01-02T00:00:00.000Z',
        articleExternalId: 'external-1',
        articleId: 'article-1',
        articleTitle: 'Title',
        conflictFlag: false,
        duplicateFlag: false,
        fullTextPdf: 'file.pdf',
        journalTitle: 'Journal',
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
    return statement.includes('LEFT JOIN app.review_selected_article_import_v4 selected')
  })
  const inserts = statements.filter((statement) => {
    return statement.includes('INSERT INTO mart.review_article_serving_v4')
  })

  expect(result).toEqual({rowCount: 2})
  expect(selectStatement).toContain('FROM mart.project_scope_article scope')
  expect(selectStatement).not.toContain('selected_scoped_article_import')
  expect(inserts).toHaveLength(2)
  expect(inserts.join('\n')).toContain('article_title')
  expect(inserts.join('\n')).toContain('full_text_pdf')
})
