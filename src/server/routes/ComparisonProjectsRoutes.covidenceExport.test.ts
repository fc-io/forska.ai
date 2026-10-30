import {readFileSync} from 'node:fs'

import {afterAll, beforeAll, expect, setDefaultTimeout, test} from 'bun:test'
import {Elysia} from 'elysia'

import {createTempRuntimeRoot} from '../test/createTempRuntimeRoot.ts'

setDefaultTimeout(180_000)

const tempRuntimeRoot = createTempRuntimeRoot('comparison-projects-covidence-export')

process.env.SERVER_ROLE = 'dev-single'
process.env.DUCKDB_PATH = tempRuntimeRoot.duckdbPath
process.env.API_SERVER_PORT = process.env.API_SERVER_PORT ?? '3001'
process.env.VITE_PORT = process.env.VITE_PORT ?? '3000'

const comparisonProjectId = 'covidence-export-summary'
const promptModeComparisonProjectId = 'covidence-export-prompt-mode'
const fullTextReviewCsv = readFileSync(
  new URL('../../../assets/covidence_study/full_text_review.csv', import.meta.url),
  'utf8',
)
const covidenceFirstRecordLine = fullTextReviewCsv.split('\n')[1] ?? ''

const getCsvLineFields = (line: string) => {
  const matches = Array.from(line.matchAll(/("(?:[^"]|"")*"|[^,"]*)(,|$)/gu))
  const lastFieldIndex = matches.findIndex((match) => {
    return match[2] === ''
  })

  return matches.slice(0, lastFieldIndex + 1).map(([, value = '']) => {
    return value.startsWith('"') ? value.slice(1, -1).replaceAll('""', '"') : value
  })
}

const [
  covidenceTitle = '',
  covidenceAuthors = '',
  covidenceAbstract = '',
  covidenceYear = '',
  ,
  covidenceJournal = '',
  covidenceVolume = '',
  covidenceIssue = '',
  covidencePages = '',
] = getCsvLineFields(covidenceFirstRecordLine)

const getRisRecord = (lines: string[]) => {
  return [...lines, 'ER  - '].join('\r\n')
}

const exportedCovidenceFirstRecord = getRisRecord([
  'TY  - JOUR',
  `TI  - ${covidenceTitle}`,
  ...covidenceAuthors.split('; ').map((author) => {
    return `AU  - ${author}`
  }),
  `AB  - ${covidenceAbstract.replace(/\s+/gu, ' ').trim()}`,
  `PY  - ${covidenceYear}`,
  `JO  - ${covidenceJournal}`,
  `VL  - ${covidenceVolume}`,
  `IS  - ${covidenceIssue}`,
  `SP  - ${covidencePages}`,
  'DO  - 10.1017/ash.2025.2',
  'KW  - Not RCT',
  'ID  - #5011',
])

type ComparisonProjectColumn = {id: string; kind: 'human' | 'llm'}
type CovidenceExportRequest = {
  columnSelections: Array<{columnId: string; values: string[]}>
  conflictResolutionValues?: string[]
}

let app: {handle: (request: Request) => Promise<Response>} | null = null
let database: {close: () => Promise<void>; run: (statement: string) => Promise<void>} | null = null
let columns: ComparisonProjectColumn[] = []

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

const getColumnId = (kind: ComparisonProjectColumn['kind']) => {
  const column = columns.find((candidate) => {
    return candidate.kind === kind
  })

  if (!column) {
    throw new Error(`Missing ${kind} column`)
  }

  return column.id
}

const postCovidenceExport = async (request: CovidenceExportRequest, id = comparisonProjectId) => {
  const response = await postJson(`/api/comparison-projects/${id}/covidence-export`, request)

  return {response, text: new TextDecoder('utf-8', {ignoreBOM: true}).decode(await response.arrayBuffer())}
}

const postCovidenceExportCount = async (request: CovidenceExportRequest, id = comparisonProjectId) => {
  const response = await postJson(`/api/comparison-projects/${id}/covidence-export/count`, request)

  return {body: (await response.json()) as {data: {totalCount: number} | null; error?: string}, response}
}

const getRisRecords = (risText: string) => {
  return risText.split('\r\n\r\n').filter((record) => {
    return record !== ''
  })
}

const getSqlString = (value: string) => {
  return `'${value.replaceAll("'", "''")}'`
}

const getCovidenceRawPayload = async () => {
  const {mergeCovidenceReferenceRows, parseCovidenceReferenceRows} =
    await import('../services/covidenceImportService.ts')
  const parsed = parseCovidenceReferenceRows({
    content: fullTextReviewCsv,
    fileRole: 'all',
    format: 'csv',
    sourceFileName: 'full_text_review.csv',
  })

  if (!parsed.ok) {
    throw new Error(parsed.error.message)
  }

  const [candidate] = mergeCovidenceReferenceRows(parsed.rows, 'title_abstract').candidates

  if (!candidate) {
    throw new Error('Missing Covidence candidate')
  }

  return JSON.stringify({covidence: {citation: candidate.citation, notes: candidate.notes, tags: candidate.tags}})
}

const seedComparisonProjects = async () => {
  const covidenceRawPayload = await getCovidenceRawPayload()
  const outOfScopeRawPayload = JSON.stringify({
    covidence: {citation: {covidence: '#9999', title: 'Other review citation'}, notes: [], tags: []},
  })

  await getDatabase().run(`
    INSERT INTO app.provider_connection (id, provider_kind, label, enabled, auth_mode)
    VALUES ('cov-connection', 'openrouter', 'OpenRouter', TRUE, 'api-key');

    INSERT INTO app.model (id, provider_connection_id, name, remote_model_id, display_name, source, enabled)
    VALUES ('cov-model', 'cov-connection', 'gpt-5.5', 'cov-model', 'GPT 5.5', 'manual', TRUE);

    INSERT INTO app.project (id, name, description, model_id, human_judgment_mode, use_title, use_abstract, use_fulltext, use_fulltext_no_images)
    VALUES
      ('cov-source', 'Covidence source', NULL, 'cov-model', 'summary', TRUE, TRUE, FALSE, FALSE),
      ('cov-prompt-source', 'Prompt source', NULL, 'cov-model', 'prompt', TRUE, TRUE, FALSE, FALSE);

    INSERT INTO app.prompt (id, original_text, prompt_heading, type, content_hash)
    VALUES
      ('cov-include', 'Population text', 'Population', '''yes'' | ''no'' | ''maybe''', 'cov-include-hash'),
      ('cov-exclude', 'Exclusion text', 'Exclusion', '''yes'' | ''no'' | ''maybe''', 'cov-exclude-hash');

    INSERT INTO app.project_prompt (id, project_id, prompt_id, prompt_order, enabled, criteria_disposition, criteria_section_key, criteria_section_label)
    VALUES
      ('cov-source-include', 'cov-source', 'cov-include', 0, TRUE, 'include', 'population', 'Population'),
      ('cov-source-exclude', 'cov-source', 'cov-exclude', 1, TRUE, 'exclude', 'exclusion', 'Exclusion'),
      ('cov-prompt-source-include', 'cov-prompt-source', 'cov-include', 0, TRUE, NULL, NULL, NULL);

    INSERT INTO app.article (
      id, article_id, article_title, article_summary, article_created_at, article_authors, doi, pubmed_id, source_metadata
    )
    VALUES
      ('cov-article-1', 'external-1', 'Canonical title one', 'Summary one', TIMESTAMPTZ '2026-10-01T00:00:00Z', ['Someone, Else'], '10.9999/not-the-citation', NULL, NULL),
      ('cov-article-2', 'external-2', 'Fallback article two', 'Summary two', TIMESTAMPTZ '2026-10-02T00:00:00Z', ['Lapitan, Marie-Carmela', 'Buckley, Brian S'], '10.1000/test.2', '30000002', '{"journalTitle":"Journal of tests","publicationYear":2021,"publicationMonth":"Mar","volume":"7","issue":"2","pages":"10-20"}'),
      ('cov-article-3', 'external-3', 'Resolved article three', 'Summary three', TIMESTAMPTZ '2026-10-03T00:00:00Z', NULL, NULL, NULL, NULL),
      ('cov-article-4', 'external-4', 'Matching article four', 'Summary, "four"', TIMESTAMPTZ '2026-10-04T00:00:00Z', NULL, NULL, NULL, NULL),
      ('cov-article-5', 'external-5', 'Excluded article five', 'Summary five', TIMESTAMPTZ '2026-10-05T00:00:00Z', NULL, NULL, NULL, NULL),
      ('cov-article-6', 'external-6', 'Excluded article six', 'Summary six', TIMESTAMPTZ '2026-10-06T00:00:00Z', NULL, NULL, NULL, NULL);

    INSERT INTO app.project_article (id, project_id, article_id)
    VALUES
      ('cov-source-article-1', 'cov-source', 'cov-article-1'),
      ('cov-source-article-2', 'cov-source', 'cov-article-2'),
      ('cov-source-article-3', 'cov-source', 'cov-article-3'),
      ('cov-source-article-4', 'cov-source', 'cov-article-4'),
      ('cov-source-article-5', 'cov-source', 'cov-article-5'),
      ('cov-source-article-6', 'cov-source', 'cov-article-6');

    INSERT INTO app.judgment (
      id, article_id, prompt_id, model_id, project_id, is_answered, answered_original,
      use_title, use_abstract, use_fulltext, use_fulltext_no_images
    )
    VALUES
      ('cov-j-1-include', 'cov-article-1', 'cov-include', 'cov-model', 'cov-source', TRUE, 'yes', TRUE, TRUE, FALSE, FALSE),
      ('cov-j-1-exclude', 'cov-article-1', 'cov-exclude', 'cov-model', 'cov-source', TRUE, 'no', TRUE, TRUE, FALSE, FALSE),
      ('cov-j-2-include', 'cov-article-2', 'cov-include', 'cov-model', 'cov-source', TRUE, 'no', TRUE, TRUE, FALSE, FALSE),
      ('cov-j-2-exclude', 'cov-article-2', 'cov-exclude', 'cov-model', 'cov-source', TRUE, 'no', TRUE, TRUE, FALSE, FALSE),
      ('cov-j-3-include', 'cov-article-3', 'cov-include', 'cov-model', 'cov-source', TRUE, 'no', TRUE, TRUE, FALSE, FALSE),
      ('cov-j-3-exclude', 'cov-article-3', 'cov-exclude', 'cov-model', 'cov-source', TRUE, 'no', TRUE, TRUE, FALSE, FALSE),
      ('cov-j-4-include', 'cov-article-4', 'cov-include', 'cov-model', 'cov-source', TRUE, 'yes', TRUE, TRUE, FALSE, FALSE),
      ('cov-j-4-exclude', 'cov-article-4', 'cov-exclude', 'cov-model', 'cov-source', TRUE, 'no', TRUE, TRUE, FALSE, FALSE),
      ('cov-j-5-include', 'cov-article-5', 'cov-include', 'cov-model', 'cov-source', TRUE, 'no', TRUE, TRUE, FALSE, FALSE),
      ('cov-j-5-exclude', 'cov-article-5', 'cov-exclude', 'cov-model', 'cov-source', TRUE, 'no', TRUE, TRUE, FALSE, FALSE),
      ('cov-j-6-include', 'cov-article-6', 'cov-include', 'cov-model', 'cov-source', TRUE, 'maybe', TRUE, TRUE, FALSE, FALSE),
      ('cov-j-6-exclude', 'cov-article-6', 'cov-exclude', 'cov-model', 'cov-source', TRUE, 'no', TRUE, TRUE, FALSE, FALSE);

    INSERT INTO app.judgment_human_summary (id, project_id, article_id, answer, origin)
    VALUES
      ('cov-h-1', 'cov-source', 'cov-article-1', 'no', 'manual_override'),
      ('cov-h-2', 'cov-source', 'cov-article-2', 'maybe', 'manual_override'),
      ('cov-h-3', 'cov-source', 'cov-article-3', 'yes', 'manual_override'),
      ('cov-h-4', 'cov-source', 'cov-article-4', 'maybe', 'manual_override'),
      ('cov-h-5', 'cov-source', 'cov-article-5', 'no', 'manual_override'),
      ('cov-h-6', 'cov-source', 'cov-article-6', 'yes', 'manual_override');

    INSERT INTO app.import_route (id, route, name, active)
    VALUES
      ('cov-route', 'covidence:cov-test', 'Covidence test', TRUE),
      ('cov-other-route', 'covidence:other-review', 'Other review', TRUE);

    INSERT INTO app.project_import_route (id, project_id, import_route_id)
    VALUES ('cov-source-route', 'cov-source', 'cov-route');

    INSERT INTO app.article_import_route (id, article_id, import_route_id, external_article_id, source_kind, raw_payload)
    VALUES
      ('cov-air-1', 'cov-article-1', 'cov-route', 'covidence:1', 'covidence', ${getSqlString(covidenceRawPayload)}),
      ('cov-air-2', 'cov-article-2', 'cov-other-route', 'covidence:2', 'covidence', ${getSqlString(outOfScopeRawPayload)});

    INSERT INTO app.comparison_project (
      id, name, description, model_ids, compare_with_humans, allow_conflict_resolution, human_judgment_mode,
      summary_source_project_id, use_title, use_abstract, use_fulltext, use_fulltext_no_images
    )
    VALUES
      ('${comparisonProjectId}', 'Covidence export', NULL, ['cov-model'], TRUE, TRUE, 'summary', 'cov-source', TRUE, TRUE, FALSE, FALSE),
      ('${promptModeComparisonProjectId}', 'Covidence prompt mode', NULL, ['cov-model'], TRUE, TRUE, 'prompt', NULL, TRUE, TRUE, FALSE, FALSE);

    INSERT INTO app.comparison_project_prompt (id, comparison_project_id, prompt_id, prompt_order, criteria_disposition, criteria_section_key, criteria_section_label)
    VALUES
      ('cov-cp-include', '${comparisonProjectId}', 'cov-include', 0, 'include', 'population', 'Population'),
      ('cov-cp-exclude', '${comparisonProjectId}', 'cov-exclude', 1, 'exclude', 'exclusion', 'Exclusion'),
      ('cov-prompt-cp-include', '${promptModeComparisonProjectId}', 'cov-include', 0, NULL, NULL, NULL);

    INSERT INTO app.comparison_project_source_project (id, comparison_project_id, source_project_id)
    VALUES
      ('cov-cp-source', '${comparisonProjectId}', 'cov-source'),
      ('cov-prompt-cp-source', '${promptModeComparisonProjectId}', 'cov-prompt-source');
  `)
}

const postResolution = async (articleId: string, value: string) => {
  const response = await postJson(`/api/comparison-projects/${comparisonProjectId}/conflict-resolution`, {
    articleId,
    value,
  })

  expect(response.status).toBe(200)
}

const loadColumns = async () => {
  const response = await getApp().handle(new Request(`http://localhost/api/comparison-projects/${comparisonProjectId}`))
  const body = (await response.json()) as {data: {columns: ComparisonProjectColumn[]}}

  expect(response.status).toBe(200)
  return body.data.columns
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
  await rebuildModule.getComparisonProjectServingRebuildService().rebuildComparisonProjectServing(comparisonProjectId)
  columns = await loadColumns()
  await postResolution('cov-article-3', 'yes')
  await postResolution('cov-article-4', 'yes')
  await postResolution('cov-article-6', 'no')
})

afterAll(async () => {
  await database?.close()
  tempRuntimeRoot.cleanup()
})

const getUnionRequest = (): CovidenceExportRequest => {
  return {
    columnSelections: [
      {columnId: getColumnId('llm'), values: ['YES']},
      {columnId: getColumnId('human'), values: [' maybe ']},
      {columnId: 'llm:retired-model:1100:summary', values: ['no']},
    ],
    conflictResolutionValues: ['Yes'],
  }
}

test('the summary compare project has one human and one LLM summary column', () => {
  expect(
    columns.map((column) => {
      return column.kind
    }),
  ).toEqual(['llm', 'human'])
})

test('Covidence export routes return 404 for unknown projects and 409 for prompt-mode projects', async () => {
  const request = {columnSelections: [{columnId: 'human:summary', values: ['yes']}]}
  const missingExport = await postCovidenceExport(request, 'missing-comparison-project')
  const missingCount = await postCovidenceExportCount(request, 'missing-comparison-project')
  const promptModeExport = await postCovidenceExport(request, promptModeComparisonProjectId)
  const promptModeCount = await postCovidenceExportCount(request, promptModeComparisonProjectId)

  expect(missingExport.response.status).toBe(404)
  expect(missingCount.response.status).toBe(404)
  expect(promptModeExport.response.status).toBe(409)
  expect(JSON.parse(promptModeExport.text)).toEqual({
    data: null,
    error: 'Covidence export requires a compare project that compares against human summary answers',
  })
  expect(promptModeCount.response.status).toBe(409)
  expect(promptModeCount.body.data).toBeNull()
})

test('the RIS download has the RIS content type, a .ris filename, no BOM and CRLF record lines', async () => {
  const {response, text} = await postCovidenceExport(getUnionRequest())
  const lines = text.slice(0, -'\r\n'.length).split('\r\n')

  expect(response.status).toBe(200)
  expect(response.headers.get('content-type')).toBe('application/x-research-info-systems; charset=utf-8')
  expect(response.headers.get('content-disposition')).toMatch(
    /^attachment; filename="Covidence_export_covidence_full_text_export_\d{4}-\d{2}-\d{2}\.ris"$/u,
  )
  expect(text.startsWith('TY  - JOUR\r\n')).toBe(true)
  expect(text.endsWith('\r\nER  - \r\n\r\n')).toBe(true)
  expect(text.replaceAll('\r\n', '')).not.toMatch(/[\r\n\uFEFF]/u)
  lines.forEach((line) => {
    expect(line).toMatch(/^$|^ER {2}- $|^[A-Z][A-Z0-9] {2}- \S(?:.*\S)?$/u)
  })
  expect(
    lines.filter((line) => {
      return line === ''
    }),
  ).toHaveLength(getRisRecords(text).length)
})

test('articles are the union of human, LLM and conflict resolution matches, each exported once', async () => {
  const {text} = await postCovidenceExport(getUnionRequest())
  const records = getRisRecords(text)

  expect(records).toHaveLength(4)
  expect([...records].sort()).toEqual(
    [
      exportedCovidenceFirstRecord,
      getRisRecord([
        'TY  - JOUR',
        'TI  - Fallback article two',
        'AU  - Lapitan, Marie-Carmela',
        'AU  - Buckley, Brian S',
        'AB  - Summary two',
        'PY  - 2021',
        'JO  - Journal of tests',
        'VL  - 7',
        'IS  - 2',
        'SP  - 10',
        'EP  - 20',
        'DO  - 10.1000/test.2',
        'AN  - 30000002',
      ]),
      getRisRecord(['TY  - JOUR', 'TI  - Resolved article three', 'AB  - Summary three']),
      getRisRecord(['TY  - JOUR', 'TI  - Matching article four', 'AB  - Summary, "four"']),
    ].sort(),
  )
})

test('the Covidence citation of an in-scope import wins and an out-of-scope Covidence import is ignored', async () => {
  const {text} = await postCovidenceExport({
    columnSelections: [
      {columnId: getColumnId('llm'), values: ['yes']},
      {columnId: getColumnId('human'), values: ['maybe']},
    ],
  })
  const exportedCovidenceRecord = getRisRecords(text).find((record) => {
    return record.startsWith('TY  - JOUR\r\nTI  - Examining the impact of treatment guidelines')
  })

  expect(covidenceFirstRecordLine).toContain(
    ',https://dx.doi.org/10.1017/ash.2025.2,40026775,#5011,Abbas 2025,"",Not RCT',
  )
  expect(exportedCovidenceRecord).toBe(exportedCovidenceFirstRecord)
  expect(text).not.toContain('Canonical title one')
  expect(text).not.toContain('10.9999/not-the-citation')
  expect(text).not.toContain('#9999')
  expect(text).not.toContain('Other review citation')
})

test('the count endpoint returns the number of RIS records for the same selection', async () => {
  const llmColumnId = getColumnId('llm')
  const humanColumnId = getColumnId('human')
  const requests: CovidenceExportRequest[] = [
    getUnionRequest(),
    {columnSelections: [{columnId: humanColumnId, values: ['yes']}]},
    {columnSelections: [{columnId: llmColumnId, values: ['no', 'maybe']}]},
    {columnSelections: [], conflictResolutionValues: ['no']},
    {columnSelections: [{columnId: llmColumnId, values: []}], conflictResolutionValues: []},
    {columnSelections: [{columnId: 'llm:retired-model:1100:summary', values: ['yes', 'no', 'maybe']}]},
  ]
  const results = await Promise.all(
    requests.map(async (request) => {
      const [count, ris] = await Promise.all([postCovidenceExportCount(request), postCovidenceExport(request)])

      return {count: count.body.data?.totalCount, risRecords: getRisRecords(ris.text).length}
    }),
  )

  expect(results).toEqual([
    {count: 4, risRecords: 4},
    {count: 2, risRecords: 2},
    {count: 4, risRecords: 4},
    {count: 1, risRecords: 1},
    {count: 0, risRecords: 0},
    {count: 0, risRecords: 0},
  ])
})

test('the export ignores the comparison page filters', async () => {
  const unfiltered = await postCovidenceExportCount(getUnionRequest())
  const withPageFilters = await postCovidenceExportCount({
    ...getUnionRequest(),
    ...({differenceFilter: ['human-vs-llm'], rowFilter: ['fully-answered']} as Record<string, unknown>),
  } as CovidenceExportRequest)

  expect(withPageFilters.response.status).toBe(200)
  expect(withPageFilters.body.data).toEqual(unfiltered.body.data)
})
