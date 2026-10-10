import {afterAll, beforeAll, expect, setDefaultTimeout, test} from 'bun:test'
import {Elysia} from 'elysia'

import {createTempRuntimeRoot} from '../test/createTempRuntimeRoot.ts'
import {SimplePdfDocument} from '../utils/simplePdf.ts'
import {pdfConflictResolutionNotSetValue} from './comparisonProjectsRoutes/comparisonProjectConflictResolutionPdfImport.ts'

setDefaultTimeout(180_000)

const tempRuntimeRoot = createTempRuntimeRoot('comparison-projects-resolution-comment')

process.env.SERVER_ROLE = 'dev-single'
process.env.DUCKDB_PATH = tempRuntimeRoot.duckdbPath
process.env.API_SERVER_PORT = process.env.API_SERVER_PORT ?? '3001'
process.env.VITE_PORT = process.env.VITE_PORT ?? '3000'

const sourceComparisonProjectId = 'comment-comparison-a'
const targetComparisonProjectId = 'comment-comparison-b'

type ResolutionResponse = {
  data: {
    articleId: string
    comment: string | null
    commentUpdatedAt: string | null
    setAt: string | null
    value: string
  } | null
  error?: unknown
}

type ResolutionRow = {
  articleId: string
  comment: string | null
  commentUpdatedAt: string | null
  id: string
  origin: string | null
  setAt: string
}

type TransferArtifact = {
  rows: Array<{comment?: string | null; provenance?: unknown; sourceResolutionId: string | null}>
  version: number
} & Record<string, unknown>

let app: {handle: (request: Request) => Promise<Response>} | null = null
let database: {
  close: () => Promise<void>
  queryJson: <T>(statement: string) => Promise<T[]>
  run: (statement: string) => Promise<void>
} | null = null

const getApp = () => {
  if (!app) {
    throw new Error('App not initialized')
  }

  return app
}

const getDatabase = () => {
  if (!database) {
    throw new Error('Database not initialized')
  }

  return database
}

const postJson = (path: string, body: unknown) => {
  return getApp().handle(
    new Request(`http://localhost${path}`, {
      body: JSON.stringify(body),
      headers: {'content-type': 'application/json'},
      method: 'POST',
    }),
  )
}

const postComment = async (
  articleId: string,
  comment: string | null,
  comparisonProjectId = sourceComparisonProjectId,
) => {
  const response = await postJson(`/api/comparison-projects/${comparisonProjectId}/conflict-resolution/comment`, {
    articleId,
    comment,
  })

  const text = await response.text()

  return {
    body: (response.ok ? JSON.parse(text) : {data: null, error: text}) as ResolutionResponse,
    status: response.status,
  }
}

const postResolution = async (articleId: string, value: string, comparisonProjectId = sourceComparisonProjectId) => {
  const response = await postJson(`/api/comparison-projects/${comparisonProjectId}/conflict-resolution`, {
    articleId,
    value,
  })

  expect(response.status).toBe(200)
  return (await response.json()) as ResolutionResponse
}

const getResolutionRows = (comparisonProjectId: string) => {
  return getDatabase().queryJson<ResolutionRow>(`
    SELECT
      id,
      article_id AS articleId,
      comment,
      CAST(comment_updated_at AS VARCHAR) AS commentUpdatedAt,
      origin,
      CAST(updated_at AS VARCHAR) AS setAt
    FROM app.comparison_project_conflict_resolution
    WHERE comparison_project_id = '${comparisonProjectId}'
    ORDER BY article_id ASC
  `)
}

const getListedResolution = async (articleId: string) => {
  const response = await postJson(`/api/comparison-projects/${sourceComparisonProjectId}/judgments`, {limit: 50})
  const body = (await response.json()) as {
    data: {data: Array<{canonicalArticleId: string; conflictResolution: ResolutionResponse['data']}>}
  }

  expect(response.status).toBe(200)
  return (
    body.data.data.find((row) => {
      return row.canonicalArticleId === articleId
    })?.conflictResolution ?? null
  )
}

const seedComparisonProjects = async () => {
  await getDatabase().run(`
    INSERT INTO app.provider_connection (id, provider_kind, label, enabled, auth_mode)
    VALUES ('comment-connection', 'openrouter', 'OpenRouter', TRUE, 'api-key');

    INSERT INTO app.model (id, provider_connection_id, name, remote_model_id, display_name, source, enabled)
    VALUES ('comment-model', 'comment-connection', 'gpt-5.5', 'comment-model', 'GPT 5.5', 'manual', TRUE);

    INSERT INTO app.project (id, name, description, model_id, human_judgment_mode, use_title, use_abstract, use_fulltext, use_fulltext_no_images)
    VALUES ('comment-source', 'Comment source', NULL, 'comment-model', 'summary', TRUE, TRUE, FALSE, FALSE);

    INSERT INTO app.prompt (id, original_text, prompt_heading, type, content_hash)
    VALUES
      ('comment-include', 'Population text', 'Population', '''yes'' | ''no'' | ''maybe''', 'comment-include-hash'),
      ('comment-exclude', 'Exclusion text', 'Exclusion', '''yes'' | ''no'' | ''maybe''', 'comment-exclude-hash');

    INSERT INTO app.project_prompt (id, project_id, prompt_id, prompt_order, enabled, criteria_disposition, criteria_section_key, criteria_section_label)
    VALUES
      ('comment-source-include', 'comment-source', 'comment-include', 0, TRUE, 'include', 'population', 'Population'),
      ('comment-source-exclude', 'comment-source', 'comment-exclude', 1, TRUE, 'exclude', 'exclusion', 'Exclusion');

    INSERT INTO app.article (id, article_id, article_title, article_summary, article_created_at)
    VALUES
      ('comment-article-1', 'external-1', 'Comment article one', 'Summary one', TIMESTAMPTZ '2026-10-01T00:00:00Z'),
      ('comment-article-2', 'external-2', 'Comment article two', 'Summary two', TIMESTAMPTZ '2026-10-02T00:00:00Z'),
      ('comment-article-3', 'external-3', 'Comment article three', 'Summary three', TIMESTAMPTZ '2026-10-03T00:00:00Z');

    INSERT INTO app.project_article (id, project_id, article_id)
    VALUES
      ('comment-source-article-1', 'comment-source', 'comment-article-1'),
      ('comment-source-article-2', 'comment-source', 'comment-article-2'),
      ('comment-source-article-3', 'comment-source', 'comment-article-3');

    INSERT INTO app.judgment (
      id, article_id, prompt_id, model_id, project_id, is_answered, answered_original,
      use_title, use_abstract, use_fulltext, use_fulltext_no_images
    )
    VALUES
      ('comment-j-1-include', 'comment-article-1', 'comment-include', 'comment-model', 'comment-source', TRUE, 'yes', TRUE, TRUE, FALSE, FALSE),
      ('comment-j-1-exclude', 'comment-article-1', 'comment-exclude', 'comment-model', 'comment-source', TRUE, 'no', TRUE, TRUE, FALSE, FALSE),
      ('comment-j-2-include', 'comment-article-2', 'comment-include', 'comment-model', 'comment-source', TRUE, 'yes', TRUE, TRUE, FALSE, FALSE),
      ('comment-j-2-exclude', 'comment-article-2', 'comment-exclude', 'comment-model', 'comment-source', TRUE, 'no', TRUE, TRUE, FALSE, FALSE),
      ('comment-j-3-include', 'comment-article-3', 'comment-include', 'comment-model', 'comment-source', TRUE, 'yes', TRUE, TRUE, FALSE, FALSE),
      ('comment-j-3-exclude', 'comment-article-3', 'comment-exclude', 'comment-model', 'comment-source', TRUE, 'no', TRUE, TRUE, FALSE, FALSE);

    INSERT INTO app.judgment_human_summary (id, project_id, article_id, answer, origin)
    VALUES
      ('comment-h-1', 'comment-source', 'comment-article-1', 'no', 'manual_override'),
      ('comment-h-2', 'comment-source', 'comment-article-2', 'no', 'manual_override'),
      ('comment-h-3', 'comment-source', 'comment-article-3', 'yes', 'manual_override');

    INSERT INTO app.comparison_project (
      id, name, description, model_ids, compare_with_humans, allow_conflict_resolution, human_judgment_mode,
      summary_source_project_id, use_title, use_abstract, use_fulltext, use_fulltext_no_images
    )
    VALUES
      ('${sourceComparisonProjectId}', 'Comment A', NULL, ['comment-model'], TRUE, TRUE, 'summary', 'comment-source', TRUE, TRUE, FALSE, FALSE),
      ('${targetComparisonProjectId}', 'Comment B', NULL, ['comment-model'], TRUE, TRUE, 'summary', 'comment-source', TRUE, TRUE, FALSE, FALSE);

    INSERT INTO app.comparison_project_prompt (id, comparison_project_id, prompt_id, prompt_order, criteria_disposition, criteria_section_key, criteria_section_label)
    VALUES
      ('comment-a-include', '${sourceComparisonProjectId}', 'comment-include', 0, 'include', 'population', 'Population'),
      ('comment-a-exclude', '${sourceComparisonProjectId}', 'comment-exclude', 1, 'exclude', 'exclusion', 'Exclusion'),
      ('comment-b-include', '${targetComparisonProjectId}', 'comment-include', 0, 'include', 'population', 'Population'),
      ('comment-b-exclude', '${targetComparisonProjectId}', 'comment-exclude', 1, 'exclude', 'exclusion', 'Exclusion');

    INSERT INTO app.comparison_project_source_project (id, comparison_project_id, source_project_id)
    VALUES
      ('comment-a-source', '${sourceComparisonProjectId}', 'comment-source'),
      ('comment-b-source', '${targetComparisonProjectId}', 'comment-source');
  `)
}

beforeAll(async () => {
  const [{migrateDuckdb}, {getAppDatabaseService}, {comparisonProjectsRoutes}, rebuildModule] = await Promise.all([
    import('../../db/migrateDuckdb.ts'),
    import('../services/appDatabaseService.ts'),
    import('./ComparisonProjectsRoutes.ts'),
    import('../services/comparisonProjectServingRebuildService.ts'),
  ])

  await migrateDuckdb()
  database = getAppDatabaseService()
  app = new Elysia().use(comparisonProjectsRoutes)
  await seedComparisonProjects()
  await rebuildModule
    .getComparisonProjectServingRebuildService()
    .rebuildComparisonProjectServing(sourceComparisonProjectId)
  await rebuildModule
    .getComparisonProjectServingRebuildService()
    .rebuildComparisonProjectServing(targetComparisonProjectId)
})

afterAll(async () => {
  await database?.close()
  tempRuntimeRoot.cleanup()
})

test('a comment needs an existing resolution and is trimmed, capped and cleared in place', async () => {
  const withoutResolution = await postComment('comment-article-1', 'Too early')

  expect(withoutResolution.status).toBe(400)
  expect(await getResolutionRows(sourceComparisonProjectId)).toEqual([])

  const saved = await postResolution('comment-article-1', 'yes')
  const [savedRow] = await getResolutionRows(sourceComparisonProjectId)

  expect(saved.data).toMatchObject({comment: null, commentUpdatedAt: null, value: 'yes'})

  const commented = await postComment('comment-article-1', '  Checked the full text; "maybe" before  ')
  const [commentedRow] = await getResolutionRows(sourceComparisonProjectId)

  expect(commented.status).toBe(200)
  expect(commented.body.data).toMatchObject({
    articleId: 'comment-article-1',
    comment: 'Checked the full text; "maybe" before',
    setAt: saved.data?.setAt,
    value: 'yes',
  })
  expect(typeof commented.body.data?.commentUpdatedAt).toBe('string')
  expect(commentedRow).toMatchObject({
    comment: 'Checked the full text; "maybe" before',
    id: savedRow?.id,
    setAt: savedRow?.setAt,
  })
  expect(commentedRow?.commentUpdatedAt).not.toBeNull()
  expect(await getListedResolution('comment-article-1')).toMatchObject({
    comment: 'Checked the full text; "maybe" before',
    commentUpdatedAt: commented.body.data?.commentUpdatedAt,
  })

  const tooLong = await postComment('comment-article-1', 'x'.repeat(4001))
  const atLimit = await postComment('comment-article-1', ` ${'y'.repeat(4000)} `)

  expect(tooLong.status).toBe(400)
  expect(atLimit.status).toBe(200)
  expect(atLimit.body.data?.comment).toBe('y'.repeat(4000))

  const cleared = await postComment('comment-article-1', '   ')
  const removed = await postComment('comment-article-1', null)
  const [clearedRow] = await getResolutionRows(sourceComparisonProjectId)

  expect(cleared.status).toBe(200)
  expect(cleared.body.data?.comment).toBeNull()
  expect(removed.status).toBe(200)
  expect(removed.body.data?.comment).toBeNull()
  expect(clearedRow).toMatchObject({comment: null, id: savedRow?.id, setAt: savedRow?.setAt})
})

test('re-resolving carries the comment over and reset removes it', async () => {
  const commented = await postComment('comment-article-1', 'Population unclear')
  const [beforeRow] = await getResolutionRows(sourceComparisonProjectId)
  const reResolved = await postResolution('comment-article-1', 'no')
  const [afterRow] = await getResolutionRows(sourceComparisonProjectId)

  expect(reResolved.data).toMatchObject({
    comment: 'Population unclear',
    commentUpdatedAt: commented.body.data?.commentUpdatedAt,
    value: 'no',
  })
  expect(afterRow?.id).not.toBe(beforeRow?.id)
  expect(afterRow).toMatchObject({comment: 'Population unclear', commentUpdatedAt: beforeRow?.commentUpdatedAt})

  const resetResponse = await postJson(
    `/api/comparison-projects/${sourceComparisonProjectId}/conflict-resolution/reset`,
    {articleId: 'comment-article-1'},
  )

  expect(resetResponse.status).toBe(200)
  expect(await getResolutionRows(sourceComparisonProjectId)).toEqual([])
  expect((await postComment('comment-article-1', 'After reset')).status).toBe(400)
  expect((await postResolution('comment-article-1', 'yes')).data).toMatchObject({comment: null, commentUpdatedAt: null})
})

test('the CSV export writes the comment next to the resolution', async () => {
  await postComment('comment-article-1', 'Line one,\nline "two"')

  const response = await postJson(`/api/comparison-projects/${sourceComparisonProjectId}/export`, {format: 'csv'})
  const responseText = await response.text()
  const csv = responseText.slice(responseText.indexOf('Title'))

  expect(response.status).toBe(200)
  expect(csv.split('\n')[0]?.split(',').slice(0, 5)).toEqual([
    'Title',
    'Abstract/Summary',
    'Date added',
    'Conflict Handling',
    'Resolution comment',
  ])
  expect(csv).toContain('Comment article one,Summary one,2026-10-01T00:00:00.000Z,yes,"Line one,\nline ""two""",yes,no')
  expect(csv).toContain('Comment article two,Summary two,2026-10-02T00:00:00.000Z,,,yes,no')
  expect(csv).toContain('Comment article three,Summary three,2026-10-03T00:00:00.000Z,No conflict,,yes,yes')
})

test('export version 2 carries the comment and the file import stores it', async () => {
  await postResolution('comment-article-2', 'no')

  const exportResponse = await postJson(
    `/api/comparison-projects/${sourceComparisonProjectId}/conflict-resolutions/export`,
    {},
  )
  const artifact = (await exportResponse.json()) as TransferArtifact
  const sourceRows = await getResolutionRows(sourceComparisonProjectId)
  const exportedComments = artifact.rows.map((row) => {
    return {comment: row.comment, sourceResolutionId: row.sourceResolutionId}
  })

  expect(exportResponse.status).toBe(200)
  expect(artifact.version).toBe(2)
  expect(exportedComments).toEqual([
    {comment: 'Line one,\nline "two"', sourceResolutionId: sourceRows[0]?.id ?? ''},
    {comment: null, sourceResolutionId: sourceRows[1]?.id ?? ''},
  ])

  const importResponse = await postJson(
    `/api/comparison-projects/${targetComparisonProjectId}/conflict-resolutions/import/commit`,
    {artifact, importMode: 'conflicting-only', overwriteMode: 'skip-existing'},
  )
  const importedRows = await getResolutionRows(targetComparisonProjectId)

  expect(importResponse.status).toBe(200)
  expect(
    importedRows.map((row) => {
      return [row.articleId, row.comment, row.commentUpdatedAt === null, row.origin]
    }),
  ).toEqual([
    ['comment-article-1', 'Line one,\nline "two"', false, 'file-import'],
    ['comment-article-2', null, true, 'file-import'],
  ])

  const {judgmentContexts: _judgmentContexts, ...artifactWithoutContexts} = artifact
  const versionOneArtifact = {
    ...artifactWithoutContexts,
    rows: artifact.rows.map(({comment: _comment, provenance: _provenance, ...row}) => {
      return row
    }),
    version: 1,
  }

  await getDatabase().run(
    `DELETE FROM app.comparison_project_conflict_resolution WHERE comparison_project_id = '${targetComparisonProjectId}'`,
  )
  const versionOneImportResponse = await postJson(
    `/api/comparison-projects/${targetComparisonProjectId}/conflict-resolutions/import/commit`,
    {artifact: versionOneArtifact, importMode: 'conflicting-only', overwriteMode: 'skip-existing'},
  )

  expect(versionOneImportResponse.status).toBe(200)
  expect(
    (await getResolutionRows(targetComparisonProjectId)).map((row) => {
      return [row.articleId, row.comment, row.commentUpdatedAt]
    }),
  ).toEqual([
    ['comment-article-1', null, null],
    ['comment-article-2', null, null],
  ])
})

test('comments keep quotes, SQL comment markers, tabs and newlines, and reject other control characters', async () => {
  const comment = "Reviewer's note -- see the 'protocol'; ok'--\n\tsecond line"
  const saved = await postComment('comment-article-1', comment)
  const [row] = await getResolutionRows(sourceComparisonProjectId)

  expect(saved.status).toBe(200)
  expect(saved.body.data?.comment).toBe(comment)
  expect(row?.comment).toBe(comment)

  const withNull = await postComment('comment-article-1', 'before\u0000after')
  const withBell = await postComment('comment-article-1', 'ring\u0007')
  const [unchangedRow] = await getResolutionRows(sourceComparisonProjectId)

  expect(withNull.status).toBe(400)
  expect(withNull.body.error).toContain('control characters')
  expect(withBell.status).toBe(400)
  expect(unchangedRow?.comment).toBe(comment)
})

const getPdfMetadataValue = (value: unknown) => {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')
}

const getReviewPdf = (resolutionValue: string) => {
  const pdf = new SimplePdfDocument()

  pdf.addTextField({
    fieldName: 'forska.import.format',
    hidden: true,
    value: getPdfMetadataValue({format: 'forska.comparisonProject.pdfConflictResolutionImport', version: 1}),
  })
  pdf.addTextField({
    fieldName: 'forska.import.comparisonProject',
    hidden: true,
    value: getPdfMetadataValue({
      allowConflictResolution: true,
      comparisonProjectId: targetComparisonProjectId,
      comparisonProjectName: 'Comment B',
      humanJudgmentMode: 'summary',
    }),
  })
  pdf.addTextField({fieldName: 'forska.reviewer.displayName', value: 'Dr PDF'})
  pdf.addTextField({
    fieldName: `comparison.${targetComparisonProjectId}.article.comment-article-1.metadata`,
    hidden: true,
    value: getPdfMetadataValue({
      articleExternalId: 'external-1',
      articleTitle: 'Comment article one',
      canonicalArticleId: 'comment-article-1',
      comparisonProjectId: targetComparisonProjectId,
      hasConflict: true,
      identifiers: [],
    }),
  })
  pdf.addRadioRow(`comparison.${targetComparisonProjectId}.article.comment-article-1.resolution`, resolutionValue, [
    {label: 'Undecided', value: pdfConflictResolutionNotSetValue},
    {label: 'Yes', value: 'yes'},
    {label: 'No', value: 'no'},
    {label: 'Maybe', value: 'maybe'},
  ])

  return pdf.toBuffer()
}

const commitPdfImport = (resolutionValue: string, pdfUndecidedMode: 'clear' | 'ignore') => {
  const formData = new FormData()

  formData.append('file', new File([getReviewPdf(resolutionValue)], 'review.pdf', {type: 'application/pdf'}))
  formData.append('importMode', 'conflicting-only')
  formData.append('overwriteMode', 'overwrite-different')
  formData.append('pdfUndecidedMode', pdfUndecidedMode)

  return getApp().handle(
    new Request(
      `http://localhost/api/comparison-projects/${targetComparisonProjectId}/conflict-resolutions/import/pdf/commit`,
      {body: formData, method: 'POST'},
    ),
  )
}

const setTargetResolution = async (value: string, comment: string) => {
  await postResolution('comment-article-1', value, targetComparisonProjectId)
  await postComment('comment-article-1', comment, targetComparisonProjectId)

  return (await getResolutionRows(targetComparisonProjectId)).find((row) => {
    return row.articleId === 'comment-article-1'
  })
}

const getTargetArticleOneRow = async () => {
  return (await getResolutionRows(targetComparisonProjectId)).find((row) => {
    return row.articleId === 'comment-article-1'
  })
}

const commitFileImport = async (artifact: unknown, overwriteMode: 'overwrite-different' | 'skip-existing') => {
  const response = await postJson(
    `/api/comparison-projects/${targetComparisonProjectId}/conflict-resolutions/import/commit`,
    {artifact, importMode: 'conflicting-only', overwriteMode},
  )

  expect(response.status).toBe(200)
}

test('imports replace a target comment only when the source row carries a comment field', async () => {
  await postResolution('comment-article-1', 'yes')
  await postComment('comment-article-1', 'Source note')
  const artifact = (await (
    await postJson(`/api/comparison-projects/${sourceComparisonProjectId}/conflict-resolutions/export`, {})
  ).json()) as TransferArtifact
  const {judgmentContexts: _judgmentContexts, ...artifactWithoutContexts} = artifact
  const withoutCommentField = {
    ...artifact,
    rows: artifact.rows.map(({comment: _comment, ...row}) => {
      return row
    }),
  }
  const versionOne = {
    ...artifactWithoutContexts,
    rows: artifact.rows.map(({comment: _comment, provenance: _provenance, ...row}) => {
      return row
    }),
    version: 1,
  }
  const withNullComment = {
    ...artifact,
    rows: artifact.rows.map((row) => {
      return {...row, comment: null}
    }),
  }

  const targetBefore = await setTargetResolution('no', 'Target note')
  await commitFileImport(withoutCommentField, 'overwrite-different')
  expect(await getTargetArticleOneRow()).toMatchObject({
    comment: 'Target note',
    commentUpdatedAt: targetBefore?.commentUpdatedAt,
    origin: 'file-import',
  })

  await setTargetResolution('no', 'Target note')
  await commitFileImport(versionOne, 'overwrite-different')
  expect(await getTargetArticleOneRow()).toMatchObject({comment: 'Target note', origin: 'file-import'})

  await setTargetResolution('no', 'Target note')
  await commitFileImport(artifact, 'skip-existing')
  expect(await getTargetArticleOneRow()).toMatchObject({comment: 'Target note', origin: 'ui'})

  await commitFileImport(artifact, 'overwrite-different')
  const replacedRow = await getTargetArticleOneRow()
  expect(replacedRow).toMatchObject({comment: 'Source note', origin: 'file-import'})
  expect(replacedRow?.commentUpdatedAt).not.toBeNull()

  await setTargetResolution('no', 'Target note')
  await commitFileImport(withNullComment, 'overwrite-different')
  expect(await getTargetArticleOneRow()).toMatchObject({comment: null, commentUpdatedAt: null, origin: 'file-import'})
})

test('PDF imports keep the target comment, and clearing an undecided article removes it with the row', async () => {
  const targetBefore = await setTargetResolution('no', 'Target note')
  const importResponse = await commitPdfImport('yes', 'ignore')

  expect(importResponse.status).toBe(200)
  expect(await getTargetArticleOneRow()).toMatchObject({
    comment: 'Target note',
    commentUpdatedAt: targetBefore?.commentUpdatedAt,
    origin: 'pdf-import',
  })

  const clearResponse = await commitPdfImport(pdfConflictResolutionNotSetValue, 'clear')

  expect(clearResponse.status).toBe(200)
  expect(await getTargetArticleOneRow()).toBeUndefined()
})
