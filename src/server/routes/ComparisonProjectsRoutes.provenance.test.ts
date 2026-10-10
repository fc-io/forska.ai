import {createHash} from 'node:crypto'

import {afterAll, beforeAll, expect, setDefaultTimeout, test} from 'bun:test'
import {Elysia} from 'elysia'

import {createTempRuntimeRoot} from '../test/createTempRuntimeRoot.ts'
import {SimplePdfDocument} from '../utils/simplePdf.ts'

setDefaultTimeout(180_000)

const tempRuntimeRoot = createTempRuntimeRoot('comparison-projects-provenance')

process.env.SERVER_ROLE = 'dev-single'
process.env.DUCKDB_PATH = tempRuntimeRoot.duckdbPath
process.env.API_SERVER_PORT = process.env.API_SERVER_PORT ?? '3001'
process.env.VITE_PORT = process.env.VITE_PORT ?? '3000'

const sourceComparisonProjectId = 'provenance-comparison-a'
const targetComparisonProjectId = 'provenance-comparison-b'

type ResolutionRow = {
  articleId: string
  judgmentContextId: string | null
  origin: string | null
  originRef: string | null
  reviewerDisplayName: string | null
  reviewerUserId: string | null
  servingGeneration: string | null
}

type JudgmentsPageResponse = {
  data: {
    data: Array<{
      canonicalArticleId: string
      conflictResolution: {
        provenance: {contextId: string | null; generation: number | null; origin: string | null} | null
        provenanceMatchesCurrent: boolean | null
        reviewer: {displayName: string | null; userId: string} | null
        value: string
      } | null
    }>
  }
}

type TransferArtifact = {
  judgmentContexts?: Array<{context: unknown; id: string}>
  rows: Array<{
    provenance?: {contextId: string | null; origin: string | null; reviewerDisplayName: string | null} | null
    sourceResolutionId: string | null
  }>
  version: number
}

let app: {handle: (request: Request) => Promise<Response>} | null = null
let database: {
  close: () => Promise<void>
  queryJson: <T>(statement: string) => Promise<T[]>
  run: (statement: string) => Promise<void>
} | null = null
let backfillModule: typeof import('../services/comparisonJudgmentContextBackfill.ts') | null = null

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

const getJson = async <T>(path: string) => {
  const response = await getApp().handle(new Request(`http://localhost${path}`))

  expect(response.status).toBe(200)
  return (await response.json()) as T
}

const getResolutionRows = (comparisonProjectId: string) => {
  return getDatabase().queryJson<ResolutionRow>(`
    SELECT
      article_id AS articleId,
      judgment_context_id AS judgmentContextId,
      origin,
      origin_ref AS originRef,
      reviewer_display_name AS reviewerDisplayName,
      reviewer_user_id AS reviewerUserId,
      CAST(serving_generation AS VARCHAR) AS servingGeneration
    FROM app.comparison_project_conflict_resolution
    WHERE comparison_project_id = '${comparisonProjectId}'
    ORDER BY article_id ASC
  `)
}

const getActiveContextId = async (comparisonProjectId: string): Promise<string> => {
  const [row] = await getDatabase().queryJson<{judgmentContextId: string}>(`
    SELECT context_serving.judgment_context_id AS judgmentContextId
    FROM mart.comparison_judgment_context_serving context_serving
    INNER JOIN app.comparison_project_serving_generation status
      ON status.comparison_project_id = context_serving.comparison_project_id
     AND status.active_generation = context_serving.generation
    WHERE context_serving.comparison_project_id = '${comparisonProjectId}'
  `)

  return row?.judgmentContextId ?? ''
}

const getListedArticleIds = async (comparisonProjectId: string, conflictResolutionProvenanceFilter: string[]) => {
  const response = await postJson(`/api/comparison-projects/${comparisonProjectId}/judgments`, {
    conflictResolutionProvenanceFilter,
    limit: 50,
  })
  const body = (await response.json()) as JudgmentsPageResponse

  expect(response.status).toBe(200)
  return body.data.data
    .map((row) => {
      return row.canonicalArticleId
    })
    .sort()
}

const getListedCount = async (comparisonProjectId: string, conflictResolutionProvenanceFilter: string[]) => {
  const response = await postJson(`/api/comparison-projects/${comparisonProjectId}/judgments/count`, {
    conflictResolutionProvenanceFilter,
    limit: 50,
  })
  const body = (await response.json()) as {data: {totalCount: number}}

  expect(response.status).toBe(200)
  return body.data.totalCount
}

const getPdfMetadataValue = (value: unknown) => {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')
}

const getExportedPdfProjectMetadata = (pdfBuffer: Buffer) => {
  const encodedValue =
    /\/T \(forska\.import\.comparisonProject\)[\s\S]*?\/V \(([^)]*)\)/.exec(pdfBuffer.toString('latin1'))?.[1] ?? ''

  return JSON.parse(Buffer.from(encodedValue, 'base64url').toString('utf8')) as Record<string, unknown>
}

const getFilledReviewPdf = (judgmentContextId: string) => {
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
      comparisonProjectId: sourceComparisonProjectId,
      comparisonProjectName: 'Provenance A',
      humanJudgmentMode: 'summary',
      judgmentContextId,
    }),
  })
  pdf.addTextField({fieldName: 'forska.reviewer.displayName', value: 'Dr PDF'})
  pdf.addTextField({
    fieldName: `comparison.${sourceComparisonProjectId}.article.provenance-article-1.metadata`,
    hidden: true,
    value: getPdfMetadataValue({
      articleExternalId: 'external-1',
      articleTitle: 'Provenance article one',
      canonicalArticleId: 'provenance-article-1',
      comparisonProjectId: sourceComparisonProjectId,
      hasConflict: true,
      identifiers: [],
    }),
  })
  pdf.addRadioRow(`comparison.${sourceComparisonProjectId}.article.provenance-article-1.resolution`, 'yes', [
    {label: 'Yes', value: 'yes'},
    {label: 'No', value: 'no'},
    {label: 'Maybe', value: 'maybe'},
  ])

  return pdf.toBuffer()
}

const seedComparisonProjects = async () => {
  await getDatabase().run(`
    INSERT INTO app.provider_connection (id, provider_kind, label, enabled, auth_mode)
    VALUES ('provenance-connection', 'openrouter', 'OpenRouter', TRUE, 'api-key');

    INSERT INTO app.model (id, provider_connection_id, name, remote_model_id, display_name, source, enabled)
    VALUES ('provenance-model', 'provenance-connection', 'gpt-5.5', 'provenance-model', 'GPT 5.5', 'manual', TRUE);

    INSERT INTO app.project (id, name, description, model_id, human_judgment_mode, use_title, use_abstract, use_fulltext, use_fulltext_no_images)
    VALUES ('provenance-source', 'Provenance source', NULL, 'provenance-model', 'summary', TRUE, TRUE, FALSE, FALSE);

    INSERT INTO app.prompt (id, original_text, prompt_heading, type, content_hash)
    VALUES
      ('provenance-include', 'Population text', 'Population', '''yes'' | ''no'' | ''maybe''', 'provenance-include-hash'),
      ('provenance-exclude', 'Exclusion text', 'Exclusion', '''yes'' | ''no'' | ''maybe''', 'provenance-exclude-hash');

    INSERT INTO app.project_prompt (id, project_id, prompt_id, prompt_order, enabled, criteria_disposition, criteria_section_key, criteria_section_label)
    VALUES
      ('provenance-source-include', 'provenance-source', 'provenance-include', 0, TRUE, 'include', 'population', 'Population'),
      ('provenance-source-exclude', 'provenance-source', 'provenance-exclude', 1, TRUE, 'exclude', 'exclusion', 'Exclusion');

    INSERT INTO app.article (id, article_id, article_title, article_summary, article_created_at)
    VALUES
      ('provenance-article-1', 'external-1', 'Provenance article one', 'Summary one', TIMESTAMPTZ '2026-10-01T00:00:00Z'),
      ('provenance-article-2', 'external-2', 'Provenance article two', 'Summary two', TIMESTAMPTZ '2026-10-02T00:00:00Z'),
      ('provenance-article-3', 'external-3', 'Provenance article three', 'Summary three', TIMESTAMPTZ '2026-10-03T00:00:00Z');

    INSERT INTO app.project_article (id, project_id, article_id)
    VALUES
      ('provenance-source-article-1', 'provenance-source', 'provenance-article-1'),
      ('provenance-source-article-2', 'provenance-source', 'provenance-article-2'),
      ('provenance-source-article-3', 'provenance-source', 'provenance-article-3');

    INSERT INTO app.judgment (
      id, article_id, prompt_id, model_id, project_id, is_answered, answered_original,
      use_title, use_abstract, use_fulltext, use_fulltext_no_images
    )
    VALUES
      ('provenance-j-1-include', 'provenance-article-1', 'provenance-include', 'provenance-model', 'provenance-source', TRUE, 'yes', TRUE, TRUE, FALSE, FALSE),
      ('provenance-j-1-exclude', 'provenance-article-1', 'provenance-exclude', 'provenance-model', 'provenance-source', TRUE, 'no', TRUE, TRUE, FALSE, FALSE),
      ('provenance-j-2-include', 'provenance-article-2', 'provenance-include', 'provenance-model', 'provenance-source', TRUE, 'yes', TRUE, TRUE, FALSE, FALSE),
      ('provenance-j-2-exclude', 'provenance-article-2', 'provenance-exclude', 'provenance-model', 'provenance-source', TRUE, 'no', TRUE, TRUE, FALSE, FALSE),
      ('provenance-j-3-include', 'provenance-article-3', 'provenance-include', 'provenance-model', 'provenance-source', TRUE, 'yes', TRUE, TRUE, FALSE, FALSE),
      ('provenance-j-3-exclude', 'provenance-article-3', 'provenance-exclude', 'provenance-model', 'provenance-source', TRUE, 'no', TRUE, TRUE, FALSE, FALSE);

    INSERT INTO app.judgment_human_summary (id, project_id, article_id, answer, origin)
    VALUES
      ('provenance-h-1', 'provenance-source', 'provenance-article-1', 'no', 'manual_override'),
      ('provenance-h-2', 'provenance-source', 'provenance-article-2', 'no', 'manual_override'),
      ('provenance-h-3', 'provenance-source', 'provenance-article-3', 'yes', 'manual_override');

    INSERT INTO app.comparison_project (
      id, name, description, model_ids, compare_with_humans, allow_conflict_resolution, human_judgment_mode,
      summary_source_project_id, use_title, use_abstract, use_fulltext, use_fulltext_no_images
    )
    VALUES
      ('${sourceComparisonProjectId}', 'Provenance A', NULL, ['provenance-model'], TRUE, TRUE, 'summary', 'provenance-source', TRUE, TRUE, FALSE, FALSE),
      ('${targetComparisonProjectId}', 'Provenance B', NULL, ['provenance-model'], TRUE, TRUE, 'summary', 'provenance-source', TRUE, TRUE, FALSE, FALSE);

    INSERT INTO app.comparison_project_prompt (id, comparison_project_id, prompt_id, prompt_order, criteria_disposition, criteria_section_key, criteria_section_label)
    VALUES
      ('provenance-a-include', '${sourceComparisonProjectId}', 'provenance-include', 0, 'include', 'population', 'Population'),
      ('provenance-a-exclude', '${sourceComparisonProjectId}', 'provenance-exclude', 1, 'exclude', 'exclusion', 'Exclusion'),
      ('provenance-b-include', '${targetComparisonProjectId}', 'provenance-include', 0, 'include', 'population', 'Population'),
      ('provenance-b-exclude', '${targetComparisonProjectId}', 'provenance-exclude', 1, 'exclude', 'exclusion', 'Exclusion');

    INSERT INTO app.comparison_project_source_project (id, comparison_project_id, source_project_id)
    VALUES
      ('provenance-a-source', '${sourceComparisonProjectId}', 'provenance-source'),
      ('provenance-b-source', '${targetComparisonProjectId}', 'provenance-source');
  `)
}

beforeAll(async () => {
  const [{migrateDuckdb}, {getAppDatabaseService}, {comparisonProjectsRoutes}, rebuildModule, contextModule] =
    await Promise.all([
      import('../../db/migrateDuckdb.ts'),
      import('../services/appDatabaseService.ts'),
      import('./ComparisonProjectsRoutes.ts'),
      import('../services/comparisonProjectServingRebuildService.ts'),
      import('../services/comparisonJudgmentContextBackfill.ts'),
    ])

  await migrateDuckdb()
  database = getAppDatabaseService()
  app = new Elysia().use(comparisonProjectsRoutes)
  backfillModule = contextModule
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

test('activation writes one content-addressed context shared by identically configured comparison projects', async () => {
  const sourceContextId = await getActiveContextId(sourceComparisonProjectId)
  const detail = await getJson<{
    data: {
      judgmentContext: {id: string; models: unknown[]; prompts: unknown[]; systemPromptVariants: string[]} | null
      judgmentContextId: string | null
    }
  }>(`/api/comparison-projects/${sourceComparisonProjectId}`)
  const lookupResponse = await postJson('/api/comparison-projects/judgment-contexts', {
    ids: [sourceContextId, 'f'.repeat(64)],
  })
  const malformedLookupResponse = await postJson('/api/comparison-projects/judgment-contexts', {
    ids: [sourceContextId, 'not-a-context-id'],
  })
  const oversizedLookupResponse = await postJson('/api/comparison-projects/judgment-contexts', {
    ids: Array.from({length: 101}, (_value, index) => {
      return index.toString(16).padStart(64, '0')
    }),
  })
  const lookup = (await lookupResponse.json()) as {data: Array<{id: string}>}

  expect(sourceContextId).toMatch(/^[0-9a-f]{64}$/)
  expect(await getActiveContextId(targetComparisonProjectId)).toBe(sourceContextId)
  expect(detail.data.judgmentContextId).toBe(sourceContextId)
  expect(detail.data.judgmentContext).toMatchObject({
    id: sourceContextId,
    models: [{id: 'provenance-model', name: 'gpt-5.5'}],
    prompts: [
      {heading: null, id: 'summary'},
      {heading: 'Exclusion', id: 'provenance-exclude'},
      {heading: 'Population', id: 'provenance-include'},
    ],
    systemPromptVariants: ['legacy'],
  })
  expect(lookupResponse.status).toBe(200)
  expect(
    lookup.data.map((summary) => {
      return summary.id
    }),
  ).toEqual([sourceContextId])
  expect(malformedLookupResponse.status).toBe(422)
  expect(oversizedLookupResponse.status).toBe(422)
})

test('UI saves record the reviewer snapshot, serving generation, context and origin', async () => {
  const sourceContextId = await getActiveContextId(sourceComparisonProjectId)
  const response = await postJson(`/api/comparison-projects/${sourceComparisonProjectId}/conflict-resolution`, {
    articleId: 'provenance-article-1',
    value: 'yes',
  })
  const body = (await response.json()) as {
    data: {
      provenance: {contextId: string | null; generation: number | null; origin: string}
      provenanceMatchesCurrent: boolean
    }
  }
  const [row] = await getResolutionRows(sourceComparisonProjectId)
  const [localUser] = await getDatabase().queryJson<{id: string; name: string}>(`
    SELECT id, name FROM app.user_config WHERE id NOT LIKE 'pdf-import:%' AND id NOT LIKE 'transfer:%'
  `)

  expect(response.status).toBe(200)
  expect(body.data.provenance).toMatchObject({contextId: sourceContextId, generation: 1, origin: 'ui'})
  expect(body.data.provenanceMatchesCurrent).toBe(true)
  expect(row).toEqual({
    articleId: 'provenance-article-1',
    judgmentContextId: sourceContextId,
    origin: 'ui',
    originRef: null,
    reviewerDisplayName: localUser?.name ?? null,
    reviewerUserId: localUser?.id ?? null,
    servingGeneration: '1',
  })
})

test('the listing filter splits resolutions into current, outdated and unknown provenance', async () => {
  await getDatabase().run(`
    INSERT INTO app.comparison_project_conflict_resolution (id, comparison_project_id, article_id, answer_value)
    VALUES ('legacy-resolution-2', '${sourceComparisonProjectId}', 'provenance-article-2', 'no')
  `)

  expect(await getListedArticleIds(sourceComparisonProjectId, ['current'])).toEqual(['provenance-article-1'])
  expect(await getListedArticleIds(sourceComparisonProjectId, ['unknown'])).toEqual(['provenance-article-2'])
  expect(await getListedArticleIds(sourceComparisonProjectId, ['outdated'])).toEqual([])
  expect(await getListedArticleIds(sourceComparisonProjectId, ['current', 'unknown'])).toEqual([
    'provenance-article-1',
    'provenance-article-2',
  ])
  expect(await getListedCount(sourceComparisonProjectId, ['unknown'])).toBe(1)

  const page = (await (
    await postJson(`/api/comparison-projects/${sourceComparisonProjectId}/judgments`, {limit: 50})
  ).json()) as JudgmentsPageResponse
  const resolutionsByArticle = new Map(
    page.data.data.map((row) => {
      return [row.canonicalArticleId, row.conflictResolution] as const
    }),
  )

  expect(resolutionsByArticle.get('provenance-article-1')).toMatchObject({
    provenance: {generation: 1, origin: 'ui'},
    provenanceMatchesCurrent: true,
  })
  expect(resolutionsByArticle.get('provenance-article-2')).toMatchObject({
    provenance: null,
    provenanceMatchesCurrent: null,
    reviewer: null,
    value: 'no',
  })
  expect(resolutionsByArticle.get('provenance-article-3')).toBeNull()
})

test('stats can be restricted to resolutions made under the current context', async () => {
  const allStats = await getJson<{
    data: {
      additionalProjectStats: {resolvedTruthComparisons: Array<{resolvedCount: number}>}
      conflictResolutionProvenance: string
    }
  }>(`/api/comparison-projects/${sourceComparisonProjectId}/stats`)
  const currentStats = await getJson<{
    data: {
      additionalProjectStats: {resolvedTruthComparisons: Array<{resolvedCount: number}>}
      conflictResolutionProvenance: string
      judgmentContextId: string | null
    }
  }>(`/api/comparison-projects/${sourceComparisonProjectId}/stats?conflictResolutionProvenance=current`)

  expect(allStats.data.conflictResolutionProvenance).toBe('all')
  expect(currentStats.data.conflictResolutionProvenance).toBe('current')
  expect(currentStats.data.judgmentContextId).toBe(await getActiveContextId(sourceComparisonProjectId))
  expect(allStats.data.additionalProjectStats.resolvedTruthComparisons[0]?.resolvedCount).toBe(2)
  expect(currentStats.data.additionalProjectStats.resolvedTruthComparisons[0]?.resolvedCount).toBe(1)
})

test('export version 2 carries provenance and the judgment context, file import never attributes the importer', async () => {
  const sourceContextId = await getActiveContextId(sourceComparisonProjectId)
  const exportResponse = await postJson(
    `/api/comparison-projects/${sourceComparisonProjectId}/conflict-resolutions/export`,
    {},
  )
  const artifact = (await exportResponse.json()) as TransferArtifact
  const exportedRowsById = new Map(
    artifact.rows.map((row) => {
      return [row.sourceResolutionId, row] as const
    }),
  )

  expect(exportResponse.status).toBe(200)
  expect(artifact.version).toBe(2)
  expect(
    artifact.judgmentContexts?.map((entry) => {
      return entry.id
    }),
  ).toEqual([sourceContextId])
  expect(exportedRowsById.get('legacy-resolution-2')?.provenance).toMatchObject({
    contextId: null,
    origin: null,
    reviewerDisplayName: null,
  })

  await getDatabase().run(`DELETE FROM app.comparison_judgment_context WHERE id = '${sourceContextId}'`)
  await getDatabase().run(`
    UPDATE app.comparison_project_conflict_resolution
    SET reviewer_display_name = 'Dr Source'
    WHERE comparison_project_id = '${sourceComparisonProjectId}'
  `)

  const reExport = (await (
    await postJson(`/api/comparison-projects/${sourceComparisonProjectId}/conflict-resolutions/export`, {})
  ).json()) as TransferArtifact
  const artifactWithContext = {...reExport, judgmentContexts: artifact.judgmentContexts}
  const importResponse = await postJson(
    `/api/comparison-projects/${targetComparisonProjectId}/conflict-resolutions/import/commit`,
    {artifact: artifactWithContext, importMode: 'conflicting-only', overwriteMode: 'skip-existing'},
  )
  const importedRows = await getResolutionRows(targetComparisonProjectId)
  const transferReviewerId = `transfer:${createHash('sha256').update('Dr Source').digest('hex')}`
  const sourceRowIds = await getDatabase().queryJson<{articleId: string; id: string}>(`
    SELECT article_id AS articleId, id
    FROM app.comparison_project_conflict_resolution
    WHERE comparison_project_id = '${sourceComparisonProjectId}'
  `)
  const sourceIdsByArticle = new Map(
    sourceRowIds.map((row) => {
      return [row.articleId, row.id] as const
    }),
  )

  expect(importResponse.status).toBe(200)
  expect(importedRows).toEqual([
    {
      articleId: 'provenance-article-1',
      judgmentContextId: sourceContextId,
      origin: 'file-import',
      originRef: `${sourceComparisonProjectId}:${sourceIdsByArticle.get('provenance-article-1')}`,
      reviewerDisplayName: 'Dr Source',
      reviewerUserId: transferReviewerId,
      servingGeneration: null,
    },
    {
      articleId: 'provenance-article-2',
      judgmentContextId: null,
      origin: 'file-import',
      originRef: `${sourceComparisonProjectId}:legacy-resolution-2`,
      reviewerDisplayName: 'Dr Source',
      reviewerUserId: transferReviewerId,
      servingGeneration: null,
    },
  ])
  expect(
    await getDatabase().queryJson<{id: string}>(`
      SELECT id FROM app.comparison_judgment_context WHERE id = '${sourceContextId}'
    `),
  ).toEqual([{id: sourceContextId}])
  expect(
    await getDatabase().queryJson<{name: string}>(
      `SELECT name FROM app.user_config WHERE id = '${transferReviewerId}'`,
    ),
  ).toEqual([{name: 'Dr Source'}])
  expect(await getListedArticleIds(targetComparisonProjectId, ['current'])).toEqual(['provenance-article-1'])
})

test('version 1 artifacts still import, with unknown reviewer and context', async () => {
  const artifact = (await (
    await postJson(`/api/comparison-projects/${sourceComparisonProjectId}/conflict-resolutions/export`, {})
  ).json()) as TransferArtifact & Record<string, unknown>
  const {judgmentContexts: _judgmentContexts, ...artifactWithoutContexts} = artifact
  const versionOneArtifact = {
    ...artifactWithoutContexts,
    rows: artifact.rows.map(({provenance: _provenance, ...row}) => {
      return row
    }),
    version: 1,
  }

  await getDatabase().run(
    `DELETE FROM app.comparison_project_conflict_resolution WHERE comparison_project_id = '${targetComparisonProjectId}'`,
  )
  const importResponse = await postJson(
    `/api/comparison-projects/${targetComparisonProjectId}/conflict-resolutions/import/commit`,
    {artifact: versionOneArtifact, importMode: 'conflicting-only', overwriteMode: 'skip-existing'},
  )
  const importedRows = await getResolutionRows(targetComparisonProjectId)

  expect(importResponse.status).toBe(200)
  expect(
    importedRows.map((row) => {
      return [row.articleId, row.reviewerUserId, row.reviewerDisplayName, row.judgmentContextId, row.origin]
    }),
  ).toEqual([
    ['provenance-article-1', null, null, null, 'file-import'],
    ['provenance-article-2', null, null, null, 'file-import'],
  ])
})

test('PDF exports embed the context id and PDF imports record it with the PDF reviewer', async () => {
  const sourceContextId = await getActiveContextId(sourceComparisonProjectId)
  const pdfResponse = await postJson(`/api/comparison-projects/${sourceComparisonProjectId}/export`, {format: 'pdf'})
  const pdfBuffer = Buffer.from(await pdfResponse.arrayBuffer())
  const projectMetadata = getExportedPdfProjectMetadata(pdfBuffer)

  expect(pdfResponse.status).toBe(200)
  expect(projectMetadata.judgmentContextId).toBe(sourceContextId)

  await getDatabase().run(
    `DELETE FROM app.comparison_project_conflict_resolution WHERE comparison_project_id = '${targetComparisonProjectId}'`,
  )
  const formData = new FormData()
  formData.append(
    'file',
    new File([getFilledReviewPdf(String(projectMetadata.judgmentContextId))], 'review.pdf', {type: 'application/pdf'}),
  )
  formData.append('importMode', 'conflicting-only')
  formData.append('overwriteMode', 'skip-existing')
  const importResponse = await getApp().handle(
    new Request(
      `http://localhost/api/comparison-projects/${targetComparisonProjectId}/conflict-resolutions/import/pdf/commit`,
      {body: formData, method: 'POST'},
    ),
  )
  const importedRows = await getResolutionRows(targetComparisonProjectId)

  expect(importResponse.status).toBe(200)
  expect(importedRows.length).toBeGreaterThan(0)
  expect(
    importedRows.every((row) => {
      return (
        row.origin === 'pdf-import'
        && row.judgmentContextId === sourceContextId
        && row.reviewerUserId?.startsWith('pdf-import:') === true
        && row.reviewerDisplayName === 'Dr PDF'
        && row.servingGeneration === null
      )
    }),
  ).toBe(true)
})

test('the maintenance backfill restores a missing context row for an active generation once', async () => {
  if (!backfillModule) {
    throw new Error('Backfill not initialized')
  }

  const backfill = backfillModule.backfillNextComparisonJudgmentContext
  const state = backfillModule.createComparisonJudgmentContextBackfillState()
  const sourceContextId = await getActiveContextId(sourceComparisonProjectId)
  const runner = {
    queryJson: <T>(statement: string) => {
      return getDatabase().queryJson<T>(statement)
    },
    run: (statement: string) => {
      return getDatabase().run(statement)
    },
    transaction: <T>(
      operation: (runner: {
        queryJson: <R>(statement: string) => Promise<R[]>
        run: (statement: string) => Promise<void>
      }) => Promise<T>,
    ) => {
      return operation(getDatabase())
    },
  }

  await getDatabase().run(
    `DELETE FROM mart.comparison_judgment_context_serving WHERE comparison_project_id = '${sourceComparisonProjectId}'`,
  )

  expect(await backfill(runner, {state})).toEqual({
    comparisonProjectId: sourceComparisonProjectId,
    generation: 1,
    judgmentContextId: sourceContextId,
    status: 'written',
  })
  expect(await backfill(runner, {state})).toEqual({comparisonProjectId: null, generation: null, status: 'idle'})
  expect(await getActiveContextId(sourceComparisonProjectId)).toBe(sourceContextId)
})
