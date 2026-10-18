import {afterAll, beforeAll, beforeEach, expect, setDefaultTimeout, test} from 'bun:test'

import {localUserDefaults} from '../../../utils/localUser.ts'
import {createTempRuntimeRoot} from '../../test/createTempRuntimeRoot.ts'

setDefaultTimeout(120_000)

const tempRuntimeRoot = createTempRuntimeRoot('full-text-cron-scope')
const originalCwd = process.cwd()

process.chdir(tempRuntimeRoot.rootDirectory)
process.env.SERVER_ROLE = 'dev-single'
process.env.DUCKDB_PATH = tempRuntimeRoot.duckdbPath
process.env.API_SERVER_PORT = process.env.API_SERVER_PORT ?? '3001'
process.env.VITE_PORT = process.env.VITE_PORT ?? '3000'

const workloadContext = {
  fallbackIntent: 'reject' as const,
  routeOrJobKey: 'fullText.cronScope.test',
  workloadClass: 'background.fullText.test',
}

let database: {close: () => Promise<void>; run: (statement: string) => Promise<void>} | null = null
let scope: typeof import('./fullTextCronScope.ts') | null = null
let fetchJobs: typeof import('../fullTextJobs.ts') | null = null
let conversionJobs: typeof import('../fullTextConversionJobs.ts') | null = null

const getDatabase = () => {
  if (!database) {
    throw new Error('Test database not initialized')
  }

  return database
}

const getJobModules = () => {
  if (!fetchJobs || !conversionJobs) {
    throw new Error('Cron modules not initialized')
  }

  return {conversionJobs, fetchJobs}
}

const getScope = () => {
  if (!scope) {
    throw new Error('Scope module not initialized')
  }

  return scope
}

beforeAll(async () => {
  const [{migrateDuckdb}, {getAppDatabaseService}, {resetDuckdbServiceForTests}, {resetServerRuntimeRoleForTests}] =
    await Promise.all([
      import('../../../db/migrateDuckdb.ts'),
      import('../../services/appDatabaseService.ts'),
      import('../../utils/duckdbService.ts'),
      import('../../utils/serverRuntimeRole.ts'),
    ])

  resetDuckdbServiceForTests()
  resetServerRuntimeRoleForTests()
  await migrateDuckdb()

  database = getAppDatabaseService()
  scope = await import('./fullTextCronScope.ts')
  fetchJobs = await import('../fullTextJobs.ts')
  conversionJobs = await import('../fullTextConversionJobs.ts')

  await getDatabase().run(`
    INSERT INTO app.provider_connection (id, provider_kind, label, enabled, auth_mode, base_url)
    VALUES
      ('scope-mineru-connection', 'mineru', 'MinerU', TRUE, 'none', 'http://127.0.0.1:8000'),
      ('scope-llm-connection', 'openai-compatible', 'LLM', TRUE, 'none', 'http://127.0.0.1:9000/v1');

    INSERT INTO app.model (id, provider_connection_id, name, remote_model_id, display_name, source, enabled)
    VALUES
      ('scope-mineru-model', 'scope-mineru-connection', 'mineru-standard', 'mineru-standard', 'MinerU', 'discovered', TRUE),
      ('scope-judge-model', 'scope-llm-connection', 'judge', 'judge', 'Judge', 'discovered', TRUE);
  `)
})

afterAll(async () => {
  await database?.close()
  process.chdir(originalCwd)
  tempRuntimeRoot.cleanup()
})

const setConversionModel = async (modelId: string | null) => {
  await getDatabase().run(`
    DELETE FROM app.user_config;
    INSERT INTO app.user_config (id, name, email, role, full_text_conversion_model_id)
    VALUES (
      '${localUserDefaults.id}',
      '${localUserDefaults.name}',
      '${localUserDefaults.email}',
      NULL,
      ${modelId === null ? 'NULL' : `'${modelId}'`}
    );
  `)
}

const resetScopeRows = async () => {
  await getDatabase().run(`
    DELETE FROM app.judgment_job;
    DELETE FROM app.project_article;
    DELETE FROM app.project_import_route;
    DELETE FROM app.article_import_route;
    DELETE FROM app.import_route;
    DELETE FROM app.project;
    DELETE FROM app.article;
  `)
}

type ProjectSeed = {archived?: boolean; dateFrom?: string; id: string; runningJob?: boolean; useFulltext: boolean}

const seedProject = async ({archived = false, dateFrom, id, runningJob = false, useFulltext}: ProjectSeed) => {
  await getDatabase().run(`
    INSERT INTO app.project (id, name, model_id, use_title, use_abstract, use_fulltext, archived, date_from)
    VALUES (
      '${id}', '${id}', 'scope-judge-model', TRUE, TRUE, ${useFulltext}, ${archived},
      ${dateFrom ? `TIMESTAMPTZ '${dateFrom}'` : 'NULL'}
    )
  `)

  if (runningJob) {
    await getDatabase().run(
      `INSERT INTO app.judgment_job (id, project_id, status) VALUES ('job-${id}', '${id}', 'running')`,
    )
  }
}

type ArticleSeed = {createdAt: string; fetched?: boolean; id: string; pdf?: boolean}

const seedArticles = async (articles: ArticleSeed[]) => {
  await getDatabase().run(`
    INSERT INTO app.article (id, article_title, article_created_at, full_text_fetched_at, full_text_pdf)
    VALUES ${articles
      .map(({createdAt, fetched = false, id, pdf = false}) => {
        return `('${id}', '${id}', TIMESTAMPTZ '${createdAt}', ${fetched ? 'current_timestamp' : 'NULL'}, ${
          pdf ? `'assets/article_pdfs/${id}.pdf'` : 'NULL'
        })`
      })
      .join(', ')}
  `)
}

const linkProjectArticles = async (projectId: string, articleIds: string[]) => {
  await getDatabase().run(`
    INSERT INTO app.project_article (id, project_id, article_id)
    VALUES ${articleIds
      .map((articleId) => {
        return `('${projectId}-${articleId}', '${projectId}', '${articleId}')`
      })
      .join(', ')}
  `)
}

const linkImportRouteArticles = async (projectId: string, articleIds: string[]) => {
  const routeId = `route-${projectId}`

  await getDatabase().run(`
    INSERT INTO app.import_route (id, route, name) VALUES ('${routeId}', 'test:${routeId}', '${routeId}');
    INSERT INTO app.project_import_route (id, project_id, import_route_id)
    VALUES ('${projectId}-${routeId}', '${projectId}', '${routeId}');
    INSERT INTO app.article_import_route (id, article_id, import_route_id)
    VALUES ${articleIds
      .map((articleId) => {
        return `('${routeId}-${articleId}', '${articleId}', '${routeId}')`
      })
      .join(', ')};
  `)
}

beforeEach(async () => {
  await resetScopeRows()
  await setConversionModel('scope-mineru-model')
})

test('gate is closed by the environment kill switch before any database read', async () => {
  await seedProject({id: 'ft', useFulltext: true})

  expect(await getScope().getFullTextCronGate({enabled: false, workloadContext})).toEqual({
    open: false,
    reason: 'disabled_by_env',
  })
})

test('gate is closed while no PDF-to-text model is configured', async () => {
  await setConversionModel(null)
  await seedProject({id: 'ft', useFulltext: true})

  expect(await getScope().getFullTextCronGate({enabled: true, workloadContext})).toEqual({
    open: false,
    reason: 'conversion_model_missing',
  })
})

test('gate is closed when only archived projects or projects without full text exist', async () => {
  await seedProject({archived: true, id: 'ft-archived', useFulltext: true})
  await seedProject({id: 'plain', runningJob: true, useFulltext: false})

  expect(await getScope().getFullTextCronGate({enabled: true, workloadContext})).toEqual({
    open: false,
    reason: 'no_full_text_projects',
  })
})

test('gate opens with the configured model and lists full-text projects with running jobs first', async () => {
  await seedProject({id: 'ft-a', useFulltext: true})
  await seedProject({id: 'ft-b', runningJob: true, useFulltext: true})
  await seedProject({id: 'plain', runningJob: true, useFulltext: false})

  const gate = await getScope().getFullTextCronGate({enabled: true, workloadContext})

  expect(gate.open).toBe(true)
  expect(gate.open ? gate.runtimeConfig.modelId : null).toBe('scope-mineru-model')
  expect(
    gate.open
      ? gate.projects.map(({hasRunningJob, projectId}) => {
          return {hasRunningJob, projectId}
        })
      : [],
  ).toEqual([
    {hasRunningJob: true, projectId: 'ft-b'},
    {hasRunningJob: false, projectId: 'ft-a'},
  ])
})

test('fetch selection takes running-job project articles first, then other full-text projects, never articles outside them', async () => {
  await seedProject({dateFrom: '2020-01-01T00:00:00Z', id: 'ft-running', runningJob: true, useFulltext: true})
  await seedProject({id: 'ft-idle', useFulltext: true})
  await seedProject({id: 'plain', runningJob: true, useFulltext: false})
  await seedProject({archived: true, id: 'ft-archived', useFulltext: true})
  await seedArticles([
    {createdAt: '2021-01-01T00:00:00Z', id: 'running-route'},
    {createdAt: '2022-01-01T00:00:00Z', id: 'running-direct'},
    {createdAt: '2019-01-01T00:00:00Z', id: 'running-before-date-from'},
    {createdAt: '2023-01-01T00:00:00Z', fetched: true, id: 'running-already-fetched'},
    {createdAt: '2021-06-01T00:00:00Z', id: 'shared'},
    {createdAt: '2020-06-01T00:00:00Z', id: 'idle-direct'},
    {createdAt: '2024-01-01T00:00:00Z', id: 'plain-only'},
    {createdAt: '2024-01-01T00:00:00Z', id: 'archived-only'},
    {createdAt: '2024-01-01T00:00:00Z', id: 'orphan'},
  ])
  await linkImportRouteArticles('ft-running', ['running-route', 'running-before-date-from', 'shared'])
  await linkProjectArticles('ft-running', ['running-direct', 'running-already-fetched'])
  await linkProjectArticles('ft-idle', ['shared', 'idle-direct'])
  await linkProjectArticles('plain', ['plain-only'])
  await linkProjectArticles('ft-archived', ['archived-only'])

  const gate = await getScope().getFullTextCronGate({enabled: true, workloadContext})
  const projects = gate.open ? gate.projects : []
  const articles = await getJobModules().fetchJobs.getArticlesWithoutFullText({numberOfArticlesToFetch: 10, projects})

  expect(
    articles.map(({id}) => {
      return id
    }),
  ).toEqual(['running-direct', 'shared', 'running-route', 'idle-direct'])
})

test('fetch selection stops at the batch size inside the first project', async () => {
  await seedProject({id: 'ft-running', runningJob: true, useFulltext: true})
  await seedProject({id: 'ft-idle', useFulltext: true})
  await seedArticles([
    {createdAt: '2021-01-01T00:00:00Z', id: 'running-1'},
    {createdAt: '2022-01-01T00:00:00Z', id: 'running-2'},
    {createdAt: '2023-01-01T00:00:00Z', id: 'idle-1'},
  ])
  await linkProjectArticles('ft-running', ['running-1', 'running-2'])
  await linkProjectArticles('ft-idle', ['idle-1'])

  const gate = await getScope().getFullTextCronGate({enabled: true, workloadContext})
  const articles = await getJobModules().fetchJobs.getArticlesWithoutFullText({
    numberOfArticlesToFetch: 2,
    projects: gate.open ? gate.projects : [],
  })

  expect(
    articles.map(({id}) => {
      return id
    }),
  ).toEqual(['running-2', 'running-1'])
})

test('fetch selection runs one DuckDB query per wake and ranks a shared article by the first project whose date window it passes', async () => {
  const {getDuckdbWorkloadRuntimeMetricsSnapshot} = await import('../../utils/duckdbService.ts')

  await seedProject({dateFrom: '2021-01-01T00:00:00Z', id: 'ft-a-running', runningJob: true, useFulltext: true})
  await seedProject({id: 'ft-b', useFulltext: true})
  await seedProject({id: 'ft-c', useFulltext: true})
  await getDatabase().run(`UPDATE app.project SET date_to = TIMESTAMPTZ '2022-12-31T00:00:00Z' WHERE id = 'ft-c'`)
  await seedArticles([
    {createdAt: '2021-03-01T00:00:00Z', id: 'a-in-window'},
    {createdAt: '2020-03-01T00:00:00Z', id: 'shared-before-a-window'},
    {createdAt: '2019-03-01T00:00:00Z', id: 'b-old'},
    {createdAt: '2022-06-01T00:00:00Z', id: 'c-in-window'},
    {createdAt: '2023-06-01T00:00:00Z', id: 'c-after-date-to'},
  ])
  await linkProjectArticles('ft-a-running', ['a-in-window', 'shared-before-a-window'])
  await linkImportRouteArticles('ft-b', ['shared-before-a-window', 'b-old'])
  await linkProjectArticles('ft-c', ['c-in-window', 'c-after-date-to', 'a-in-window'])

  const gate = await getScope().getFullTextCronGate({enabled: true, workloadContext})
  const projects = gate.open ? gate.projects : []
  const getFetchQueryCount = () => {
    return getDuckdbWorkloadRuntimeMetricsSnapshot().filter((metric) => {
      return metric.routeOrJobKey === 'fullText.fetch.cron'
    }).length
  }
  const fetchQueriesBefore = getFetchQueryCount()
  const articles = await getJobModules().fetchJobs.getArticlesWithoutFullText({numberOfArticlesToFetch: 10, projects})
  const fetchQueriesAfterSelection = getFetchQueryCount()

  await getDatabase().run(`UPDATE app.article SET full_text_fetched_at = current_timestamp`)
  const emptyArticles = await getJobModules().fetchJobs.getArticlesWithoutFullText({
    numberOfArticlesToFetch: 10,
    projects,
  })
  const fetchQueriesAfterEmptyWake = getFetchQueryCount()

  expect(
    projects.map(({projectId}) => {
      return projectId
    }),
  ).toEqual(['ft-a-running', 'ft-b', 'ft-c'])
  expect(
    articles.map(({id}) => {
      return id
    }),
  ).toEqual(['a-in-window', 'shared-before-a-window', 'b-old', 'c-in-window'])
  expect(emptyArticles).toEqual([])
  expect([
    fetchQueriesAfterSelection - fetchQueriesBefore,
    fetchQueriesAfterEmptyWake - fetchQueriesAfterSelection,
  ]).toEqual([1, 1])
})

test('conversion selection only takes PDFs of full-text project articles that still need conversion', async () => {
  await seedProject({id: 'ft-idle', useFulltext: true})
  await seedProject({id: 'plain', runningJob: true, useFulltext: false})
  await seedArticles([
    {createdAt: '2021-01-01T00:00:00Z', fetched: true, id: 'ft-pdf', pdf: true},
    {createdAt: '2022-01-01T00:00:00Z', fetched: true, id: 'ft-no-pdf'},
    {createdAt: '2023-01-01T00:00:00Z', fetched: true, id: 'ft-failed', pdf: true},
    {createdAt: '2024-01-01T00:00:00Z', fetched: true, id: 'plain-pdf', pdf: true},
    {createdAt: '2024-01-01T00:00:00Z', fetched: true, id: 'orphan-pdf', pdf: true},
  ])
  await getDatabase().run(`UPDATE app.article SET full_text_conversion_status = 'failed' WHERE id = 'ft-failed'`)
  await linkProjectArticles('ft-idle', ['ft-pdf', 'ft-no-pdf', 'ft-failed'])
  await linkProjectArticles('plain', ['plain-pdf'])

  const gate = await getScope().getFullTextCronGate({enabled: true, workloadContext})
  const articles = await getJobModules().conversionJobs.getArticlesNeedingConversion({
    batchSize: 5,
    projects: gate.open ? gate.projects : [],
  })

  expect(articles).toEqual([
    {fullTextConversionAttempts: null, fullTextPDF: 'assets/article_pdfs/ft-pdf.pdf', id: 'ft-pdf'},
  ])
})

test('a fetch wake with articles logs the missing Unpaywall email once, and not when an email is set or nothing is fetched', async () => {
  if (!fetchJobs) {
    throw new Error('Test dependencies not initialized')
  }

  await getDatabase().run(`UPDATE app.user_config SET unpaywall_email = NULL`)
  const missing = await fetchJobs.logUnpaywallEmailMissing(3)
  const nothingToFetch = await fetchJobs.logUnpaywallEmailMissing(0)

  await getDatabase().run(`UPDATE app.user_config SET unpaywall_email = 'local@example.com'`)
  const configured = await fetchJobs.logUnpaywallEmailMissing(3)

  await getDatabase().run(`UPDATE app.user_config SET unpaywall_email = NULL`)

  expect([missing, nothingToFetch, configured]).toEqual([true, false, false])
})
