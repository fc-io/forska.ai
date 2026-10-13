import {afterAll, beforeAll, expect, setDefaultTimeout, test} from 'bun:test'
import {Elysia} from 'elysia'

import {createTempRuntimeRoot} from '../test/createTempRuntimeRoot.ts'
import {SimplePdfDocument} from '../utils/simplePdf.ts'
import {pdfConflictResolutionNotSetValue} from './comparisonProjectsRoutes/comparisonProjectConflictResolutionPdfImport.ts'

setDefaultTimeout(180_000)

const tempRuntimeRoot = createTempRuntimeRoot('comparison-projects-conflict-comment-pdf')

process.env.SERVER_ROLE = 'dev-single'
process.env.DUCKDB_PATH = tempRuntimeRoot.duckdbPath
process.env.API_SERVER_PORT = process.env.API_SERVER_PORT ?? '3001'
process.env.VITE_PORT = process.env.VITE_PORT ?? '3000'

const sourceComparisonProjectId = 'pdf-comment-a'
const targetComparisonProjectId = 'pdf-comment-b'

type ResolutionRow = {articleId: string; origin: string | null; reviewerUserId: string | null}

type CommentRow = {
  articleId: string
  authorDisplayName: string | null
  authorUserId: string | null
  comment: string
  createdAt: string
  updatedAt: string
}

type AnalyzeRow = {
  commentChange?: 'add' | 'keep' | 'replace'
  reason: string
  selectedResolution: string
  sourceArticleRowId: string
}

type AnalyzeBody = {
  data: {
    importableRows: AnalyzeRow[]
    skippedRows: AnalyzeRow[]
    source: {reviewer: {displayName: string | null} | null; rowCount: number}
    summary: Record<string, number>
  }
}

type ListedRow = {
  canonicalArticleId: string
  conflictComment: {author: {displayName: string | null; userId: string | null} | null; comment: string} | null
}

type PdfImportOptions = {overwriteMode?: 'overwrite-different' | 'skip-existing'; pdfUndecidedMode?: 'clear' | 'ignore'}

type CommentReviewArticle = {articleId: string; exportedComment: string | null; radio?: string | null; value?: string}

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

const postComment = async (comparisonProjectId: string, articleId: string, comment: string | null) => {
  const response = await postJson(`/api/comparison-projects/${comparisonProjectId}/conflict-comment`, {
    articleId,
    comment,
  })

  expect(response.status).toBe(200)
}

const postResolution = async (comparisonProjectId: string, articleId: string, value: string) => {
  const response = await postJson(`/api/comparison-projects/${comparisonProjectId}/conflict-resolution`, {
    articleId,
    value,
  })

  expect(response.status).toBe(200)
}

const getResolutionRows = (comparisonProjectId: string) => {
  return getDatabase().queryJson<ResolutionRow>(`
    SELECT article_id AS articleId, origin, reviewer_user_id AS reviewerUserId
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

const getPdfReviewerRows = () => {
  return getDatabase().queryJson<{id: string; name: string}>(`
    SELECT id, name FROM app.user_config WHERE id LIKE 'pdf-import:%' ORDER BY created_at ASC, id ASC
  `)
}

const getListedRow = async (comparisonProjectId: string, articleId: string) => {
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

const exportPdf = async (comparisonProjectId: string) => {
  const response = await postJson(`/api/comparison-projects/${comparisonProjectId}/export`, {format: 'pdf'})

  expect(response.status).toBe(200)
  return Buffer.from(await response.arrayBuffer())
}

const getEscapedRegExpText = (value: string) => {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

const getPdfFieldObject = (pdfText: string, fieldName: string) => {
  const match = new RegExp(
    `(\\d+) 0 obj\\n(<< /Type /Annot /Subtype /Widget /FT /Tx /T \\(${getEscapedRegExpText(fieldName)}\\)[^\\n]*>>)\\nendobj`,
  ).exec(pdfText)

  return match ? {dictionary: match[2] ?? '', objectNumber: match[1] ?? ''} : null
}

const getPdfFieldMetadata = (pdfText: string, fieldName: string) => {
  const value = /\/V \(([^)]*)\)/.exec(getPdfFieldObject(pdfText, fieldName)?.dictionary ?? '')?.[1] ?? ''

  return JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Record<string, unknown>
}

const getArticleFieldName = (comparisonProjectId: string, articleId: string, kind: string) => {
  return `comparison.${comparisonProjectId}.article.${articleId}.${kind}`
}

const getUtf16BeHexToken = (value: string) => {
  return `<FE FF ${Buffer.from(value, 'utf16le')
    .swap16()
    .toString('hex')
    .toUpperCase()
    .replace(/(.{4})/g, '$1 ')}>`
}

const appendViewerFieldUpdates = (pdfBuffer: Buffer, updates: Array<{fieldName: string; valueToken: string}>) => {
  const pdfText = pdfBuffer.toString('latin1')
  const previousXrefOffset = /startxref\n(\d+)\n%%EOF\n$/.exec(pdfText)?.[1] ?? '0'
  const size = /\/Size (\d+)/.exec(pdfText)?.[1] ?? '0'
  const objects = updates.map((update) => {
    const fieldObject = getPdfFieldObject(pdfText, update.fieldName)

    expect(fieldObject).not.toBeNull()

    return {
      body: `${fieldObject?.objectNumber} 0 obj\n${fieldObject?.dictionary.replace(/\/V (\([^)]*\)|<[^>]*>)/, `/V ${update.valueToken}`)}\nendobj\n`,
      objectNumber: fieldObject?.objectNumber ?? '0',
    }
  })
  const appended = objects.reduce<{offset: number; text: string; xref: string[]}>(
    (state, object) => {
      return {
        offset: state.offset + Buffer.byteLength(object.body, 'latin1'),
        text: `${state.text}${object.body}`,
        xref: [...state.xref, `${object.objectNumber} 1\n${String(state.offset).padStart(10, '0')} 00000 n \n`],
      }
    },
    {offset: pdfBuffer.length, text: '', xref: []},
  )
  const trailer = `xref\n${appended.xref.join('')}trailer\n<< /Size ${size} /Root 1 0 R /Prev ${previousXrefOffset} >>\nstartxref\n${appended.offset}\n%%EOF\n`

  return Buffer.concat([pdfBuffer, Buffer.from(`${appended.text}${trailer}`, 'latin1')])
}

const getPdfMetadataValue = (value: unknown) => {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')
}

const getCommentReviewPdf = (articles: CommentReviewArticle[]) => {
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
      comparisonProjectName: 'PDF comment B',
      humanJudgmentMode: 'summary',
    }),
  })
  pdf.addTextField({fieldName: 'forska.reviewer.displayName', value: 'Dr PDF'})
  articles.forEach((article) => {
    const articleNumber = article.articleId.replace('pdf-comment-article-', '')

    pdf.addTextField({
      fieldName: getArticleFieldName(targetComparisonProjectId, article.articleId, 'metadata'),
      hidden: true,
      value: getPdfMetadataValue({
        articleExternalId: `external-${articleNumber}`,
        articleTitle: `PDF comment article ${articleNumber}`,
        canonicalArticleId: article.articleId,
        comparisonProjectId: targetComparisonProjectId,
        exportedComment: article.exportedComment,
        identifiers: [],
      }),
    })

    if (article.radio !== undefined) {
      pdf.addRadioRow(getArticleFieldName(targetComparisonProjectId, article.articleId, 'resolution'), article.radio, [
        {label: 'Undecided', value: pdfConflictResolutionNotSetValue},
        {label: 'Yes', value: 'yes'},
        {label: 'No', value: 'no'},
        {label: 'Maybe', value: 'maybe'},
      ])
    }

    pdf.addTextField({
      fieldName: getArticleFieldName(targetComparisonProjectId, article.articleId, 'comment'),
      lines: 4,
      maxLength: 4000,
      multiline: true,
      value: article.value ?? article.exportedComment ?? '',
    })
  })

  return pdf.toBuffer()
}

const postPdfImport = (kind: 'analyze' | 'commit', pdf: Buffer, options: PdfImportOptions = {}) => {
  const formData = new FormData()

  formData.append('file', new File([new Uint8Array(pdf)], 'review.pdf', {type: 'application/pdf'}))
  formData.append('importMode', 'conflicting-only')
  formData.append('overwriteMode', options.overwriteMode ?? 'skip-existing')
  formData.append('pdfUndecidedMode', options.pdfUndecidedMode ?? 'ignore')

  return getApp().handle(
    new Request(
      `http://localhost/api/comparison-projects/${targetComparisonProjectId}/conflict-resolutions/import/pdf/${kind}`,
      {body: formData, method: 'POST'},
    ),
  )
}

const analyzePdfImport = async (pdf: Buffer, options: PdfImportOptions = {}) => {
  const response = await postPdfImport('analyze', pdf, options)
  const text = await response.text()

  expect(response.status, text).toBe(200)
  return JSON.parse(text) as AnalyzeBody
}

const commitPdfImport = async (pdf: Buffer, options: PdfImportOptions = {}) => {
  const response = await postPdfImport('commit', pdf, options)
  const text = await response.text()

  expect(response.status, text).toBe(200)
  return JSON.parse(text) as AnalyzeBody
}

const getRowMarkers = (rows: readonly AnalyzeRow[]) => {
  return rows.map((row) => {
    return [row.sourceArticleRowId, row.selectedResolution, row.commentChange ?? null]
  })
}

const expectOnlyTargetCommentRow = async (expected: CommentRow | undefined) => {
  const commentRows = await getCommentRows(targetComparisonProjectId)

  expect(commentRows).toHaveLength(1)
  expect(commentRows[0]).toEqual(expected)
}

const getCommentTexts = async (comparisonProjectId: string) => {
  return (await getCommentRows(comparisonProjectId)).map((row) => {
    return [row.articleId, row.comment]
  })
}

const seedComparisonProjects = async () => {
  await getDatabase().run(`
    INSERT INTO app.provider_connection (id, provider_kind, label, enabled, auth_mode)
    VALUES ('pdf-comment-connection', 'openrouter', 'OpenRouter', TRUE, 'api-key');

    INSERT INTO app.model (id, provider_connection_id, name, remote_model_id, display_name, source, enabled)
    VALUES ('pdf-comment-model', 'pdf-comment-connection', 'gpt-5.5', 'pdf-comment-model', 'GPT 5.5', 'manual', TRUE);

    INSERT INTO app.project (id, name, description, model_id, human_judgment_mode, use_title, use_abstract, use_fulltext, use_fulltext_no_images)
    VALUES ('pdf-comment-source', 'PDF comment source', NULL, 'pdf-comment-model', 'summary', TRUE, TRUE, FALSE, FALSE);

    INSERT INTO app.prompt (id, original_text, prompt_heading, type, content_hash)
    VALUES
      ('pdf-comment-include', 'Population text', 'Population', '''yes'' | ''no'' | ''maybe''', 'pdf-comment-include-hash'),
      ('pdf-comment-exclude', 'Exclusion text', 'Exclusion', '''yes'' | ''no'' | ''maybe''', 'pdf-comment-exclude-hash');

    INSERT INTO app.project_prompt (id, project_id, prompt_id, prompt_order, enabled, criteria_disposition, criteria_section_key, criteria_section_label)
    VALUES
      ('pdf-comment-source-include', 'pdf-comment-source', 'pdf-comment-include', 0, TRUE, 'include', 'population', 'Population'),
      ('pdf-comment-source-exclude', 'pdf-comment-source', 'pdf-comment-exclude', 1, TRUE, 'exclude', 'exclusion', 'Exclusion');

    INSERT INTO app.article (id, article_id, article_title, article_summary, article_created_at)
    VALUES
      ('pdf-comment-article-1', 'external-1', 'PDF comment article 1', 'Summary one', TIMESTAMPTZ '2026-10-01T00:00:00Z'),
      ('pdf-comment-article-2', 'external-2', 'PDF comment article 2', 'Summary two', TIMESTAMPTZ '2026-10-02T00:00:00Z'),
      ('pdf-comment-article-3', 'external-3', 'PDF comment article 3', 'Summary three', TIMESTAMPTZ '2026-10-03T00:00:00Z');

    INSERT INTO app.project_article (id, project_id, article_id)
    VALUES
      ('pdf-comment-source-article-1', 'pdf-comment-source', 'pdf-comment-article-1'),
      ('pdf-comment-source-article-2', 'pdf-comment-source', 'pdf-comment-article-2'),
      ('pdf-comment-source-article-3', 'pdf-comment-source', 'pdf-comment-article-3');

    INSERT INTO app.judgment (
      id, article_id, prompt_id, model_id, project_id, is_answered, answered_original,
      use_title, use_abstract, use_fulltext, use_fulltext_no_images
    )
    VALUES
      ('pdf-comment-j-1-include', 'pdf-comment-article-1', 'pdf-comment-include', 'pdf-comment-model', 'pdf-comment-source', TRUE, 'yes', TRUE, TRUE, FALSE, FALSE),
      ('pdf-comment-j-1-exclude', 'pdf-comment-article-1', 'pdf-comment-exclude', 'pdf-comment-model', 'pdf-comment-source', TRUE, 'no', TRUE, TRUE, FALSE, FALSE),
      ('pdf-comment-j-2-include', 'pdf-comment-article-2', 'pdf-comment-include', 'pdf-comment-model', 'pdf-comment-source', TRUE, 'yes', TRUE, TRUE, FALSE, FALSE),
      ('pdf-comment-j-2-exclude', 'pdf-comment-article-2', 'pdf-comment-exclude', 'pdf-comment-model', 'pdf-comment-source', TRUE, 'no', TRUE, TRUE, FALSE, FALSE),
      ('pdf-comment-j-3-include', 'pdf-comment-article-3', 'pdf-comment-include', 'pdf-comment-model', 'pdf-comment-source', TRUE, 'yes', TRUE, TRUE, FALSE, FALSE),
      ('pdf-comment-j-3-exclude', 'pdf-comment-article-3', 'pdf-comment-exclude', 'pdf-comment-model', 'pdf-comment-source', TRUE, 'no', TRUE, TRUE, FALSE, FALSE);

    INSERT INTO app.judgment_human_summary (id, project_id, article_id, answer, origin)
    VALUES
      ('pdf-comment-h-1', 'pdf-comment-source', 'pdf-comment-article-1', 'no', 'manual_override'),
      ('pdf-comment-h-2', 'pdf-comment-source', 'pdf-comment-article-2', 'no', 'manual_override'),
      ('pdf-comment-h-3', 'pdf-comment-source', 'pdf-comment-article-3', 'yes', 'manual_override');

    INSERT INTO app.comparison_project (
      id, name, description, model_ids, compare_with_humans, allow_conflict_resolution, human_judgment_mode,
      summary_source_project_id, use_title, use_abstract, use_fulltext, use_fulltext_no_images
    )
    VALUES
      ('${sourceComparisonProjectId}', 'PDF comment A', NULL, ['pdf-comment-model'], TRUE, TRUE, 'summary', 'pdf-comment-source', TRUE, TRUE, FALSE, FALSE),
      ('${targetComparisonProjectId}', 'PDF comment B', NULL, ['pdf-comment-model'], TRUE, TRUE, 'summary', 'pdf-comment-source', TRUE, TRUE, FALSE, FALSE);

    INSERT INTO app.comparison_project_prompt (id, comparison_project_id, prompt_id, prompt_order, criteria_disposition, criteria_section_key, criteria_section_label)
    VALUES
      ('pdf-comment-a-include', '${sourceComparisonProjectId}', 'pdf-comment-include', 0, 'include', 'population', 'Population'),
      ('pdf-comment-a-exclude', '${sourceComparisonProjectId}', 'pdf-comment-exclude', 1, 'exclude', 'exclusion', 'Exclusion'),
      ('pdf-comment-b-include', '${targetComparisonProjectId}', 'pdf-comment-include', 0, 'include', 'population', 'Population'),
      ('pdf-comment-b-exclude', '${targetComparisonProjectId}', 'pdf-comment-exclude', 1, 'exclude', 'exclusion', 'Exclusion');

    INSERT INTO app.comparison_project_source_project (id, comparison_project_id, source_project_id)
    VALUES
      ('pdf-comment-a-source', '${sourceComparisonProjectId}', 'pdf-comment-source'),
      ('pdf-comment-b-source', '${targetComparisonProjectId}', 'pdf-comment-source');
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

const sourceArticleOneComment = 'Population unclear – see protocol\nsecond line'
const sourceArticleThreeComment = 'Agreed now, kept for the record'

test('the PDF export prefills each comment in a multi-line field and records it as exportedComment', async () => {
  await postComment(sourceComparisonProjectId, 'pdf-comment-article-1', sourceArticleOneComment)
  await postComment(sourceComparisonProjectId, 'pdf-comment-article-3', sourceArticleThreeComment)

  const pdfText = (await exportPdf(sourceComparisonProjectId)).toString('latin1')
  const fieldName = (articleId: string, kind: string) => {
    return getArticleFieldName(sourceComparisonProjectId, articleId, kind)
  }
  const articleOneField = getPdfFieldObject(pdfText, fieldName('pdf-comment-article-1', 'comment'))?.dictionary
  const articleOneHex = /\/V <FEFF([0-9A-F]+)>/.exec(articleOneField ?? '')?.[1] ?? ''

  expect(pdfText).toContain('radio buttons and')
  expect(pdfText).toContain('attached to imported conflict resolutions and comments.')
  expect(articleOneField).toContain('/Ff 4096 /MaxLen 4000')
  expect(Buffer.from(articleOneHex, 'hex').swap16().toString('utf16le')).toBe(sourceArticleOneComment)
  expect(articleOneField).toContain(`/DV <FEFF${articleOneHex}>`)
  expect(getPdfFieldObject(pdfText, fieldName('pdf-comment-article-2', 'comment'))?.dictionary).toContain(
    '/V () /DV ()',
  )
  expect(getPdfFieldObject(pdfText, fieldName('pdf-comment-article-3', 'comment'))?.dictionary).toContain(
    `/V (${sourceArticleThreeComment})`,
  )
  expect(pdfText).toContain(`/T (${fieldName('pdf-comment-article-1', 'resolution')})`)
  expect(pdfText).toContain(`/T (${fieldName('pdf-comment-article-2', 'resolution')})`)
  expect(pdfText).not.toContain(`/T (${fieldName('pdf-comment-article-3', 'resolution')})`)
  expect(pdfText).toContain('( \\(no current conflict\\))')
  expect(pdfText.match(/\(Comment \\\(optional\\\)\)/g)).toHaveLength(3)
  expect(getPdfFieldMetadata(pdfText, fieldName('pdf-comment-article-1', 'metadata'))).toMatchObject({
    canonicalArticleId: 'pdf-comment-article-1',
    exportedComment: sourceArticleOneComment,
  })
  expect(getPdfFieldMetadata(pdfText, fieldName('pdf-comment-article-2', 'metadata'))).toMatchObject({
    exportedComment: null,
  })
  expect(getPdfFieldMetadata(pdfText, fieldName('pdf-comment-article-3', 'metadata'))).toMatchObject({
    exportedComment: sourceArticleThreeComment,
    hasConflict: false,
  })

  const untouched = await postPdfImport('analyze', await exportPdf(sourceComparisonProjectId))

  expect(untouched.status).toBe(400)
  expect(await untouched.text()).toContain('no filled conflict-resolution radio fields and no changed comments')
})

test('round trip: a comment a viewer wrote into the exported PDF lands in the target with the PDF reviewer', async () => {
  const exportedPdf = await exportPdf(sourceComparisonProjectId)
  const reviewedPdf = appendViewerFieldUpdates(exportedPdf, [
    {
      fieldName: getArticleFieldName(sourceComparisonProjectId, 'pdf-comment-article-2', 'comment'),
      valueToken: getUtf16BeHexToken('Oklart om populationen är vuxna\r\nSe protokoll \u{1F44D}'),
    },
    {fieldName: 'forska.reviewer.displayName', valueToken: '(Dr \\305sa)'},
  ])
  const preview = await analyzePdfImport(reviewedPdf)

  expect(preview.data.source).toMatchObject({reviewer: {displayName: 'Dr Åsa'}, rowCount: 1})
  expect(preview.data.summary).toMatchObject({commentsAdded: 1, commentsKept: 0, commentsReplaced: 0, importable: 1})
  expect(getRowMarkers(preview.data.importableRows)).toEqual([['pdf-comment-article-2', '', 'add']])

  const committed = await commitPdfImport(reviewedPdf)
  const [commentRow] = await getCommentRows(targetComparisonProjectId)
  const [reviewer] = await getPdfReviewerRows()

  expect(committed.data.summary).toMatchObject({commentsAdded: 1, inserted: 0})
  expect(await getResolutionRows(targetComparisonProjectId)).toEqual([])
  expect(await getCommentRows(targetComparisonProjectId)).toHaveLength(1)
  expect(commentRow).toMatchObject({
    articleId: 'pdf-comment-article-2',
    authorDisplayName: 'Dr Åsa',
    comment: 'Oklart om populationen är vuxna\nSe protokoll \u{1F44D}',
  })
  expect(commentRow?.authorUserId).toMatch(/^pdf-import:/)
  expect(reviewer).toEqual({id: commentRow?.authorUserId ?? '', name: 'Dr Åsa'})
  expect((await getListedRow(targetComparisonProjectId, 'pdf-comment-article-2'))?.conflictComment).toMatchObject({
    author: {displayName: 'Dr Åsa', userId: commentRow?.authorUserId ?? ''},
    comment: 'Oklart om populationen är vuxna\nSe protokoll \u{1F44D}',
  })
  await clearComparisonProject(targetComparisonProjectId)
})

test('round trip: PDFDocEncoding strings from a viewer arrive exactly, and a re-encoded untouched comment brings nothing', async () => {
  const exportedPdf = await exportPdf(sourceComparisonProjectId)
  const reviewedPdf = appendViewerFieldUpdates(exportedPdf, [
    {
      fieldName: getArticleFieldName(sourceComparisonProjectId, 'pdf-comment-article-1', 'comment'),
      valueToken: '(Population unclear \\205 see protocol\\rsecond line)',
    },
    {
      fieldName: getArticleFieldName(sourceComparisonProjectId, 'pdf-comment-article-2', 'comment'),
      valueToken: '(it\\220s \\205 5 \\240 \\200 \\215ok\\216)',
    },
    {fieldName: 'forska.reviewer.displayName', valueToken: '(O\\220Brien)'},
  ])
  const preview = await analyzePdfImport(reviewedPdf)

  expect(preview.data.source.reviewer?.displayName).toBe('O\u2019Brien')
  expect(preview.data.summary).toMatchObject({commentsAdded: 1, commentsReplaced: 0})
  expect(getRowMarkers(preview.data.importableRows)).toEqual([['pdf-comment-article-2', '', 'add']])

  await commitPdfImport(reviewedPdf)
  const [commentRow] = await getCommentRows(targetComparisonProjectId)
  const reviewer = (await getPdfReviewerRows()).find((row) => {
    return row.id === commentRow?.authorUserId
  })

  expect(await getCommentRows(targetComparisonProjectId)).toHaveLength(1)
  expect(commentRow).toMatchObject({
    articleId: 'pdf-comment-article-2',
    authorDisplayName: 'O\u2019Brien',
    comment: 'it\u2019s \u2013 5 \u20ac \u2022 \u201cok\u201d',
  })
  expect(reviewer?.name).toBe('O\u2019Brien')
  await clearComparisonProject(targetComparisonProjectId)
})

test('a PDF import previews comment counts and markers and writes comments with the PDF reviewer as author', async () => {
  const pdf = getCommentReviewPdf([
    {articleId: 'pdf-comment-article-1', exportedComment: null, radio: 'yes', value: 'Decided note'},
    {articleId: 'pdf-comment-article-2', exportedComment: null, radio: null, value: 'Unset note'},
    {articleId: 'pdf-comment-article-3', exportedComment: null, value: 'Not conflicting note'},
  ])
  const preview = await analyzePdfImport(pdf)

  expect(preview.data.source.rowCount).toBe(3)
  expect(preview.data.summary).toMatchObject({commentsAdded: 2, commentsKept: 0, commentsReplaced: 0, importable: 2})
  expect(getRowMarkers(preview.data.importableRows)).toEqual([
    ['pdf-comment-article-1', 'yes', 'add'],
    ['pdf-comment-article-2', '', 'add'],
  ])
  expect(
    preview.data.skippedRows.map((row) => {
      return [row.sourceArticleRowId, row.reason, row.commentChange ?? null]
    }),
  ).toEqual([['pdf-comment-article-3', 'not-conflicting', null]])

  await commitPdfImport(pdf)
  const [resolutionRow] = await getResolutionRows(targetComparisonProjectId)

  expect(resolutionRow).toMatchObject({articleId: 'pdf-comment-article-1', origin: 'pdf-import'})
  expect(resolutionRow?.reviewerUserId).toMatch(/^pdf-import:/)
  expect(
    (await getCommentRows(targetComparisonProjectId)).map((row) => {
      return [row.articleId, row.comment, row.authorUserId, row.authorDisplayName]
    }),
  ).toEqual([
    ['pdf-comment-article-1', 'Decided note', resolutionRow?.reviewerUserId ?? null, 'Dr PDF'],
    ['pdf-comment-article-2', 'Unset note', resolutionRow?.reviewerUserId ?? null, 'Dr PDF'],
  ])
  await clearComparisonProject(targetComparisonProjectId)
})

test('skip-existing keeps a different target comment, overwrite-different replaces it, identical text is a no-op', async () => {
  await postComment(targetComparisonProjectId, 'pdf-comment-article-1', 'Target note')
  const [before] = await getCommentRows(targetComparisonProjectId)
  const pdf = getCommentReviewPdf([
    {articleId: 'pdf-comment-article-1', exportedComment: null, radio: null, value: 'PDF note'},
  ])
  const keepPreview = await analyzePdfImport(pdf)

  expect(keepPreview.data.summary).toMatchObject({commentsAdded: 0, commentsKept: 1, commentsReplaced: 0})
  expect(getRowMarkers(keepPreview.data.importableRows)).toEqual([['pdf-comment-article-1', '', 'keep']])

  await commitPdfImport(pdf)
  await expectOnlyTargetCommentRow(before)

  const replacePreview = await analyzePdfImport(pdf, {overwriteMode: 'overwrite-different'})

  expect(replacePreview.data.summary).toMatchObject({commentsAdded: 0, commentsKept: 0, commentsReplaced: 1})
  expect(getRowMarkers(replacePreview.data.importableRows)).toEqual([['pdf-comment-article-1', '', 'replace']])

  await commitPdfImport(pdf, {overwriteMode: 'overwrite-different'})
  const [replaced] = await getCommentRows(targetComparisonProjectId)

  expect(replaced).toMatchObject({authorDisplayName: 'Dr PDF', comment: 'PDF note', createdAt: before?.createdAt})
  expect(replaced?.authorUserId).toMatch(/^pdf-import:/)

  const reviewerCount = (await getPdfReviewerRows()).length
  const unchangedPreview = await analyzePdfImport(pdf, {overwriteMode: 'overwrite-different'})

  await commitPdfImport(pdf, {overwriteMode: 'overwrite-different'})
  expect(unchangedPreview.data.summary).toMatchObject({commentsAdded: 0, commentsKept: 0, commentsReplaced: 0})
  expect(getRowMarkers(unchangedPreview.data.importableRows)).toEqual([['pdf-comment-article-1', '', null]])
  await expectOnlyTargetCommentRow(replaced)
  expect(await getPdfReviewerRows()).toHaveLength(reviewerCount)
  await clearComparisonProject(targetComparisonProjectId)
})

test('clearing undecided PDF selections never touches comments; a changed comment on an undecided radio still imports', async () => {
  await postResolution(targetComparisonProjectId, 'pdf-comment-article-1', 'no')
  await postComment(targetComparisonProjectId, 'pdf-comment-article-1', 'Target note')
  const [before] = await getCommentRows(targetComparisonProjectId)
  const untouchedPdf = getCommentReviewPdf([
    {articleId: 'pdf-comment-article-1', exportedComment: 'Target note', radio: pdfConflictResolutionNotSetValue},
  ])

  await commitPdfImport(untouchedPdf, {overwriteMode: 'overwrite-different', pdfUndecidedMode: 'clear'})
  expect(await getResolutionRows(targetComparisonProjectId)).toEqual([])
  await expectOnlyTargetCommentRow(before)

  await postResolution(targetComparisonProjectId, 'pdf-comment-article-1', 'no')
  const changedPdf = getCommentReviewPdf([
    {
      articleId: 'pdf-comment-article-1',
      exportedComment: 'Target note',
      radio: pdfConflictResolutionNotSetValue,
      value: 'Changed while undecided',
    },
  ])
  const preview = await analyzePdfImport(changedPdf, {overwriteMode: 'overwrite-different', pdfUndecidedMode: 'clear'})

  expect(preview.data.source.rowCount).toBe(1)
  expect(preview.data.summary).toMatchObject({commentsReplaced: 1})
  expect(getRowMarkers(preview.data.importableRows)).toEqual([
    ['pdf-comment-article-1', '', 'replace'],
    ['pdf-comment-article-1', 'Undecided', null],
  ])

  await commitPdfImport(changedPdf, {overwriteMode: 'overwrite-different', pdfUndecidedMode: 'clear'})
  expect(await getResolutionRows(targetComparisonProjectId)).toEqual([])
  expect(await getCommentRows(targetComparisonProjectId)).toHaveLength(1)
  expect(await getCommentRows(targetComparisonProjectId)).toMatchObject([
    {authorDisplayName: 'Dr PDF', comment: 'Changed while undecided'},
  ])
  await clearComparisonProject(targetComparisonProjectId)
})

test('untouched prefilled comments produce no comment changes', async () => {
  const pdf = getCommentReviewPdf([
    {articleId: 'pdf-comment-article-1', exportedComment: 'Source note', radio: 'yes'},
    {articleId: 'pdf-comment-article-2', exportedComment: 'Other note', radio: null},
  ])
  const preview = await analyzePdfImport(pdf, {overwriteMode: 'overwrite-different'})

  expect(preview.data.source.rowCount).toBe(1)
  expect(preview.data.summary).toMatchObject({commentsAdded: 0, commentsKept: 0, commentsReplaced: 0, importable: 1})
  expect(getRowMarkers(preview.data.importableRows)).toEqual([['pdf-comment-article-1', 'yes', null]])

  await commitPdfImport(pdf, {overwriteMode: 'overwrite-different'})
  expect(await getResolutionRows(targetComparisonProjectId)).toMatchObject([{articleId: 'pdf-comment-article-1'}])
  expect(await getCommentTexts(targetComparisonProjectId)).toEqual([])
  await clearComparisonProject(targetComparisonProjectId)
})
