import {afterAll, beforeAll, expect, setDefaultTimeout, test} from 'bun:test'
import {Elysia} from 'elysia'

import {createTempRuntimeRoot} from '../test/createTempRuntimeRoot.ts'
import {SimplePdfDocument} from '../utils/simplePdf.ts'
import {pdfConflictResolutionNotSetValue} from './comparisonProjectsRoutes/comparisonProjectConflictResolutionPdfImport.ts'

setDefaultTimeout(180_000)

const tempRuntimeRoot = createTempRuntimeRoot('comparison-projects-conflict-comment')

process.env.SERVER_ROLE = 'dev-single'
process.env.DUCKDB_PATH = tempRuntimeRoot.duckdbPath
process.env.API_SERVER_PORT = process.env.API_SERVER_PORT ?? '3001'
process.env.VITE_PORT = process.env.VITE_PORT ?? '3000'

const sourceComparisonProjectId = 'comment-comparison-a'
const targetComparisonProjectId = 'comment-comparison-b'

type ConflictComment = {
  author: {displayName: string | null; userId: string} | null
  comment: string
  updatedAt: string | null
}

type CommentResponse = {data: {articleId: string; conflictComment: ConflictComment | null} | null; error?: unknown}

type ResolutionResponse = {data: {articleId: string; setAt: string | null; value: string} | null; error?: unknown}

type ResolutionRow = {articleId: string; id: string; origin: string | null; setAt: string}

type CommentRow = {
  articleId: string
  authorDisplayName: string | null
  authorUserId: string | null
  comment: string
  createdAt: string
  updatedAt: string
}

type ListedRow = {
  canonicalArticleId: string
  conflictComment: ConflictComment | null
  conflictResolution: ResolutionResponse['data']
  hasConflict: boolean
}

type TransferArtifact = {
  rows: Array<{
    comment?: string | null
    provenance?: unknown
    resolution: {value: string} | null
    sourceArticleRowId: string | null
    sourceResolutionId: string | null
  }>
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
  const response = await postJson(`/api/comparison-projects/${comparisonProjectId}/conflict-comment`, {
    articleId,
    comment,
  })
  const text = await response.text()

  return {
    body: (response.ok ? JSON.parse(text) : {data: null, error: text}) as CommentResponse,
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

const postReset = async (articleId: string, comparisonProjectId = sourceComparisonProjectId) => {
  const response = await postJson(`/api/comparison-projects/${comparisonProjectId}/conflict-resolution/reset`, {
    articleId,
  })

  expect(response.status).toBe(200)
}

const getResolutionRows = (comparisonProjectId: string) => {
  return getDatabase().queryJson<ResolutionRow>(`
    SELECT id, article_id AS articleId, origin, CAST(updated_at AS VARCHAR) AS setAt
    FROM app.comparison_project_conflict_resolution
    WHERE comparison_project_id = '${comparisonProjectId}'
    ORDER BY article_id ASC
  `)
}

const getCommentRows = (comparisonProjectId: string) => {
  return getDatabase().queryJson<CommentRow>(`
    SELECT
      article_id AS articleId,
      comment,
      author_user_id AS authorUserId,
      author_display_name AS authorDisplayName,
      CAST(created_at AS VARCHAR) AS createdAt,
      CAST(updated_at AS VARCHAR) AS updatedAt
    FROM app.comparison_project_conflict_comment
    WHERE comparison_project_id = '${comparisonProjectId}'
    ORDER BY article_id ASC
  `)
}

const getCommentRow = async (articleId: string, comparisonProjectId = sourceComparisonProjectId) => {
  return (await getCommentRows(comparisonProjectId)).find((row) => {
    return row.articleId === articleId
  })
}

const getListedRow = async (articleId: string, comparisonProjectId = sourceComparisonProjectId) => {
  const response = await postJson(`/api/comparison-projects/${comparisonProjectId}/judgments`, {limit: 50})
  const body = (await response.json()) as {data: {data: ListedRow[]}}

  expect(response.status).toBe(200)
  return body.data.data.find((row) => {
    return row.canonicalArticleId === articleId
  })
}

const clearComparisonProject = async (comparisonProjectId: string) => {
  await getDatabase().run(`
    DELETE FROM app.comparison_project_conflict_resolution WHERE comparison_project_id = '${comparisonProjectId}';
    DELETE FROM app.comparison_project_conflict_comment WHERE comparison_project_id = '${comparisonProjectId}';
  `)
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

test('a comment needs no resolution and is trimmed, capped, attributed and deleted when cleared', async () => {
  const commented = await postComment('comment-article-1', '  Checked the full text; "maybe" before  ')
  const [commentRow] = await getCommentRows(sourceComparisonProjectId)

  expect(commented.status).toBe(200)
  expect(commented.body.data).toEqual({
    articleId: 'comment-article-1',
    conflictComment: {
      author: {displayName: commentRow?.authorDisplayName ?? null, userId: commentRow?.authorUserId ?? ''},
      comment: 'Checked the full text; "maybe" before',
      updatedAt: commented.body.data?.conflictComment?.updatedAt ?? null,
    },
  })
  expect(Number.isNaN(Date.parse(commented.body.data?.conflictComment?.updatedAt ?? ''))).toBe(false)
  expect(commentRow).toMatchObject({articleId: 'comment-article-1', comment: 'Checked the full text; "maybe" before'})
  expect(commentRow?.authorUserId).toBeTruthy()
  expect(await getResolutionRows(sourceComparisonProjectId)).toEqual([])
  expect(await getListedRow('comment-article-1')).toMatchObject({
    conflictComment: {
      comment: 'Checked the full text; "maybe" before',
      updatedAt: commented.body.data?.conflictComment?.updatedAt,
    },
    conflictResolution: null,
    hasConflict: true,
  })
  expect((await getListedRow('comment-article-2'))?.conflictComment).toBeNull()

  const tooLong = await postComment('comment-article-1', 'x'.repeat(4001))
  const atLimit = await postComment('comment-article-1', ` ${'y'.repeat(4000)} `)
  const [atLimitRow] = await getCommentRows(sourceComparisonProjectId)

  expect(tooLong.status).toBe(400)
  expect(tooLong.body.error).toContain('4000')
  expect(atLimit.status).toBe(200)
  expect(atLimit.body.data?.conflictComment?.comment).toBe('y'.repeat(4000))
  expect(await getCommentRows(sourceComparisonProjectId)).toHaveLength(1)
  expect(atLimitRow?.createdAt).toBe(commentRow?.createdAt)

  const cleared = await postComment('comment-article-1', '   ')

  expect(cleared.status).toBe(200)
  expect(cleared.body.data).toEqual({articleId: 'comment-article-1', conflictComment: null})
  expect(await getCommentRows(sourceComparisonProjectId)).toEqual([])

  await postComment('comment-article-1', 'Again')
  const removed = await postComment('comment-article-1', null)

  expect(removed.body.data).toEqual({articleId: 'comment-article-1', conflictComment: null})
  expect(await getCommentRows(sourceComparisonProjectId)).toEqual([])
  expect((await getListedRow('comment-article-1'))?.conflictComment).toBeNull()
})

test('a comment needs an article of the comparison project, not a current conflict', async () => {
  const unknownArticle = await postComment('not-in-this-project', 'Nope')
  const noConflict = await postComment('comment-article-3', 'Agreed now, kept for the record')

  expect(unknownArticle.status).toBe(400)
  expect(unknownArticle.body.error).toContain('articles in this comparison project')
  expect(noConflict.status).toBe(200)
  expect(await getListedRow('comment-article-3')).toMatchObject({
    conflictComment: {comment: 'Agreed now, kept for the record'},
    conflictResolution: null,
    hasConflict: false,
  })

  await postComment('comment-article-3', null)
})

test('setting, changing and resetting a resolution leaves the comment untouched', async () => {
  await postComment('comment-article-1', 'Population unclear')
  const before = await getCommentRow('comment-article-1')
  const saved = await postResolution('comment-article-1', 'yes')
  const changed = await postResolution('comment-article-1', 'no')

  expect(saved.data).toMatchObject({value: 'yes'})
  expect(saved.data).not.toHaveProperty('comment')
  expect(changed.data).toMatchObject({value: 'no'})
  expect(await getCommentRow('comment-article-1')).toEqual(before)
  expect(await getListedRow('comment-article-1')).toMatchObject({
    conflictComment: {comment: 'Population unclear'},
    conflictResolution: {value: 'no'},
  })

  await postReset('comment-article-1')

  expect(await getResolutionRows(sourceComparisonProjectId)).toEqual([])
  expect(await getCommentRow('comment-article-1')).toEqual(before)
  expect(await getListedRow('comment-article-1')).toMatchObject({
    conflictComment: {comment: 'Population unclear'},
    conflictResolution: null,
  })

  await postResolution('comment-article-1', 'yes')
  const edited = await postComment('comment-article-1', 'Population clear after all')

  expect(edited.body.data?.conflictComment?.comment).toBe('Population clear after all')
  expect(
    (await getResolutionRows(sourceComparisonProjectId)).map((row) => {
      return row.articleId
    }),
  ).toEqual(['comment-article-1'])
  await postReset('comment-article-1')
  await postComment('comment-article-1', null)
})

test('the CSV export writes the conflict comment, also for articles without a resolution', async () => {
  await postResolution('comment-article-1', 'yes')
  await postComment('comment-article-1', 'Line one,\nline "two"')
  await postComment('comment-article-2', 'No decision yet')

  const response = await postJson(`/api/comparison-projects/${sourceComparisonProjectId}/export`, {format: 'csv'})
  const responseText = await response.text()
  const csv = responseText.slice(responseText.indexOf('Title'))

  expect(response.status).toBe(200)
  expect(csv.split('\n')[0]?.split(',').slice(0, 5)).toEqual([
    'Title',
    'Abstract/Summary',
    'Date added',
    'Conflict Handling',
    'Conflict comment',
  ])
  expect(csv).toContain('Comment article one,Summary one,2026-10-01T00:00:00.000Z,yes,"Line one,\nline ""two""",yes,no')
  expect(csv).toContain('Comment article two,Summary two,2026-10-02T00:00:00.000Z,,No decision yet,yes,no')
  expect(csv).toContain('Comment article three,Summary three,2026-10-03T00:00:00.000Z,No conflict,,yes,yes')
})

test('comments keep quotes, SQL comment markers, tabs and newlines, and reject other control characters', async () => {
  const comment = "Reviewer's note -- see the 'protocol'; ok'--\n\tsecond line\r\nthird"
  const saved = await postComment('comment-article-1', comment)

  expect(saved.status).toBe(200)
  expect(saved.body.data?.conflictComment?.comment).toBe(comment)
  expect((await getCommentRow('comment-article-1'))?.comment).toBe(comment)

  const withNull = await postComment('comment-article-1', 'before\u0000after')
  const withBell = await postComment('comment-article-1', 'ring\u0007')

  expect(withNull.status).toBe(400)
  expect(withNull.body.error).toContain('control characters')
  expect(withBell.status).toBe(400)
  expect((await getCommentRow('comment-article-1'))?.comment).toBe(comment)

  await postComment('comment-article-1', 'Line one,\nline "two"')
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

  return getCommentRow('comment-article-1', targetComparisonProjectId)
}

const getTargetArticleOneResolution = async () => {
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
  return (await response.json()) as {data: {summary: {importable: number; inserted: number}}}
}

const exportSourceArtifact = async () => {
  const response = await postJson(
    `/api/comparison-projects/${sourceComparisonProjectId}/conflict-resolutions/export`,
    {},
  )

  expect(response.status).toBe(200)
  return (await response.json()) as TransferArtifact
}

const getVersionOneArtifact = (artifact: TransferArtifact) => {
  const {judgmentContexts: _judgmentContexts, ...artifactWithoutContexts} = artifact

  return {
    ...artifactWithoutContexts,
    rows: artifact.rows
      .filter((row) => {
        return row.resolution !== null
      })
      .map(({comment: _comment, provenance: _provenance, ...row}) => {
        return row
      }),
    version: 1,
  }
}

const getResolutionRowsOnly = (artifact: TransferArtifact) => {
  return artifact.rows.filter((row) => {
    return row.resolution !== null
  })
}

test('export version 3 carries comment-only rows and a file import stores them without a resolution', async () => {
  const artifact = await exportSourceArtifact()
  const sourceResolutionRows = await getResolutionRows(sourceComparisonProjectId)

  expect(artifact.version).toBe(3)
  expect(
    artifact.rows.map((row) => {
      return {
        comment: row.comment,
        hasProvenance: Object.prototype.hasOwnProperty.call(row, 'provenance'),
        resolution: row.resolution?.value ?? null,
        sourceArticleRowId: row.sourceArticleRowId,
        sourceResolutionId: row.sourceResolutionId,
      }
    }),
  ).toEqual([
    {
      comment: 'Line one,\nline "two"',
      hasProvenance: true,
      resolution: 'yes',
      sourceArticleRowId: 'comment-article-1',
      sourceResolutionId: sourceResolutionRows[0]?.id ?? '',
    },
    {
      comment: 'No decision yet',
      hasProvenance: false,
      resolution: null,
      sourceArticleRowId: 'comment-article-2',
      sourceResolutionId: null,
    },
  ])

  const analyzeResponse = await postJson(
    `/api/comparison-projects/${targetComparisonProjectId}/conflict-resolutions/import/analyze`,
    {artifact, importMode: 'conflicting-only', overwriteMode: 'skip-existing'},
  )
  const analyzeBody = (await analyzeResponse.json()) as {
    data: {
      importableRows: Array<{selectedResolution: string; sourceArticleRowId: string}>
      summary: {importable: number}
    }
  }

  expect(analyzeResponse.status).toBe(200)
  expect(analyzeBody.data.summary.importable).toBe(2)
  expect(
    analyzeBody.data.importableRows.map((row) => {
      return [row.sourceArticleRowId, row.selectedResolution]
    }),
  ).toEqual([
    ['comment-article-1', 'yes'],
    ['comment-article-2', ''],
  ])

  const committed = await commitFileImport(artifact, 'skip-existing')

  expect(committed.data.summary).toMatchObject({importable: 2, inserted: 2})
  expect(
    (await getResolutionRows(targetComparisonProjectId)).map((row) => {
      return [row.articleId, row.origin]
    }),
  ).toEqual([['comment-article-1', 'file-import']])
  expect(
    (await getCommentRows(targetComparisonProjectId)).map((row) => {
      return [row.articleId, row.comment, row.authorUserId, row.authorDisplayName]
    }),
  ).toEqual([
    ['comment-article-1', 'Line one,\nline "two"', null, null],
    ['comment-article-2', 'No decision yet', null, null],
  ])
  expect(await getListedRow('comment-article-2', targetComparisonProjectId)).toMatchObject({
    conflictComment: {author: null, comment: 'No decision yet'},
    conflictResolution: null,
  })
  await clearComparisonProject(targetComparisonProjectId)
})

test('version 1 and 2 artifacts still import, and only version 3 may carry comment-only rows', async () => {
  const artifact = await exportSourceArtifact()
  const versionTwo = {...artifact, rows: getResolutionRowsOnly(artifact), version: 2}

  await commitFileImport(versionTwo, 'skip-existing')
  expect(
    (await getCommentRows(targetComparisonProjectId)).map((row) => {
      return [row.articleId, row.comment]
    }),
  ).toEqual([['comment-article-1', 'Line one,\nline "two"']])
  await clearComparisonProject(targetComparisonProjectId)

  await commitFileImport(getVersionOneArtifact(artifact), 'skip-existing')
  expect(await getResolutionRows(targetComparisonProjectId)).toHaveLength(1)
  expect(await getCommentRows(targetComparisonProjectId)).toEqual([])
  await clearComparisonProject(targetComparisonProjectId)

  const rejected = await postJson(
    `/api/comparison-projects/${targetComparisonProjectId}/conflict-resolutions/import/commit`,
    {artifact: {...artifact, version: 2}, importMode: 'conflicting-only', overwriteMode: 'skip-existing'},
  )

  expect(rejected.status).toBe(400)
  expect(await rejected.text()).toContain('has no resolution')
  expect(await getResolutionRows(targetComparisonProjectId)).toEqual([])
  expect(await getCommentRows(targetComparisonProjectId)).toEqual([])
})

test('imports replace a target comment only when the source row carries a comment field', async () => {
  const artifact = await exportSourceArtifact()
  const withoutCommentField = {
    ...artifact,
    rows: getResolutionRowsOnly(artifact).map(({comment: _comment, ...row}) => {
      return row
    }),
  }
  const withNullComment = {
    ...artifact,
    rows: getResolutionRowsOnly(artifact).map((row) => {
      return {...row, comment: null}
    }),
  }

  const targetBefore = await setTargetResolution('no', 'Target note')
  await commitFileImport(withoutCommentField, 'overwrite-different')
  expect(await getTargetArticleOneResolution()).toMatchObject({origin: 'file-import'})
  expect(await getCommentRow('comment-article-1', targetComparisonProjectId)).toEqual(targetBefore)

  await setTargetResolution('no', 'Target note')
  await commitFileImport(getVersionOneArtifact(artifact), 'overwrite-different')
  expect(await getTargetArticleOneResolution()).toMatchObject({origin: 'file-import'})
  expect((await getCommentRow('comment-article-1', targetComparisonProjectId))?.comment).toBe('Target note')

  await setTargetResolution('no', 'Target note')
  await commitFileImport(artifact, 'skip-existing')
  expect(await getTargetArticleOneResolution()).toMatchObject({origin: 'ui'})
  expect((await getCommentRow('comment-article-1', targetComparisonProjectId))?.comment).toBe('Target note')

  await commitFileImport(artifact, 'overwrite-different')
  expect(await getTargetArticleOneResolution()).toMatchObject({origin: 'file-import'})
  expect(await getCommentRow('comment-article-1', targetComparisonProjectId)).toMatchObject({
    authorUserId: null,
    comment: 'Line one,\nline "two"',
  })

  await setTargetResolution('no', 'Target note')
  await commitFileImport(withNullComment, 'overwrite-different')
  expect(await getTargetArticleOneResolution()).toMatchObject({origin: 'file-import'})
  expect(await getCommentRow('comment-article-1', targetComparisonProjectId)).toBeUndefined()

  await clearComparisonProject(targetComparisonProjectId)
  await postComment('comment-article-1', 'Target note without a resolution', targetComparisonProjectId)
  await postComment('comment-article-2', 'Target note on two', targetComparisonProjectId)
  await commitFileImport(artifact, 'skip-existing')
  expect(await getTargetArticleOneResolution()).toMatchObject({origin: 'file-import'})
  expect(
    (await getCommentRows(targetComparisonProjectId)).map((row) => {
      return [row.articleId, row.comment]
    }),
  ).toEqual([
    ['comment-article-1', 'Target note without a resolution'],
    ['comment-article-2', 'Target note on two'],
  ])

  await commitFileImport(artifact, 'overwrite-different')
  expect(
    (await getCommentRows(targetComparisonProjectId)).map((row) => {
      return [row.articleId, row.comment]
    }),
  ).toEqual([
    ['comment-article-1', 'Target note without a resolution'],
    ['comment-article-2', 'No decision yet'],
  ])
  expect(
    (await getResolutionRows(targetComparisonProjectId)).map((row) => {
      return row.articleId
    }),
  ).toEqual(['comment-article-1'])
  await clearComparisonProject(targetComparisonProjectId)
})

test('creating a comparison project from a project copies comments, also comment-only ones, with their authors', async () => {
  const sourceComments = await getCommentRows(sourceComparisonProjectId)
  const response = await postJson('/api/comparison-projects/from-project', {
    allowConflictResolution: true,
    compareWithHumans: true,
    conflictResolutionImportSourceComparisonProjectIds: [sourceComparisonProjectId],
    description: null,
    humanJudgmentMode: 'summary',
    name: 'Comment C',
    sourceProjectId: 'comment-source',
    sourceProjectIds: ['comment-source'],
  })
  const bodyText = await response.text()

  expect(response.status, bodyText).toBe(200)

  const createdId = (JSON.parse(bodyText) as {data: {id: string}}).data.id

  expect(
    (await getResolutionRows(createdId)).map((row) => {
      return [row.articleId, row.origin]
    }),
  ).toEqual([['comment-article-1', 'project-import']])
  expect(
    (await getCommentRows(createdId)).map((row) => {
      return [row.articleId, row.comment, row.authorUserId, row.authorDisplayName]
    }),
  ).toEqual(
    sourceComments.map((row) => {
      return [row.articleId, row.comment, row.authorUserId, row.authorDisplayName]
    }),
  )
  expect(sourceComments).toHaveLength(2)
})

test('PDF imports never touch comments, also when clearing an undecided article', async () => {
  const targetBefore = await setTargetResolution('no', 'Target note')
  const importResponse = await commitPdfImport('yes', 'ignore')

  expect(importResponse.status).toBe(200)
  expect(await getTargetArticleOneResolution()).toMatchObject({origin: 'pdf-import'})
  expect(await getCommentRow('comment-article-1', targetComparisonProjectId)).toEqual(targetBefore)

  const clearResponse = await commitPdfImport(pdfConflictResolutionNotSetValue, 'clear')

  expect(clearResponse.status).toBe(200)
  expect(await getTargetArticleOneResolution()).toBeUndefined()
  expect(await getCommentRow('comment-article-1', targetComparisonProjectId)).toEqual(targetBefore)
  await clearComparisonProject(targetComparisonProjectId)
})
