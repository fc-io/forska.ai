import {expect, test} from 'bun:test'
import {existsSync, readFileSync, unlinkSync} from 'fs'

const removeFileIfExists = (filePath: string) => {
  if (existsSync(filePath)) {
    unlinkSync(filePath)
  }
}

test('getAppQueryService reads native DuckDB app tables', async () => {
  const duckdbPath = `/tmp/f1-app-query-service-${Date.now()}.duckdb`
  const init = globalThis.Bun.spawnSync([
    'duckdb',
    '-json',
    duckdbPath,
    `
      CREATE SCHEMA app;
      CREATE TABLE app.prompt (id VARCHAR PRIMARY KEY, original_text VARCHAR NOT NULL, prompt_heading VARCHAR, type VARCHAR, created_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp);
      CREATE TABLE app.project (id VARCHAR PRIMARY KEY, model_id VARCHAR, use_title BOOLEAN NOT NULL DEFAULT TRUE, use_abstract BOOLEAN NOT NULL DEFAULT TRUE, use_fulltext BOOLEAN NOT NULL DEFAULT FALSE, use_fulltext_no_images BOOLEAN NOT NULL DEFAULT FALSE, date_from TIMESTAMPTZ, date_to TIMESTAMPTZ);
      CREATE TABLE app.project_prompt (id VARCHAR PRIMARY KEY, project_id VARCHAR NOT NULL, prompt_id VARCHAR NOT NULL, prompt_order INTEGER, enabled BOOLEAN NOT NULL DEFAULT TRUE, created_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp);
      CREATE TABLE app.project_import_route (id VARCHAR PRIMARY KEY, project_id VARCHAR NOT NULL, import_route_id VARCHAR NOT NULL);
      CREATE TABLE app.article (
        id VARCHAR PRIMARY KEY,
        created_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
        article_title VARCHAR NOT NULL,
        article_authors VARCHAR[],
        article_created_at TIMESTAMPTZ,
        article_updated_at TIMESTAMPTZ,
        article_id VARCHAR,
        article_summary VARCHAR,
        article_version INTEGER,
        arxiv_id VARCHAR,
        biorxiv_id VARCHAR,
        medrxiv_id VARCHAR,
        doi VARCHAR,
        pubmed_id VARCHAR,
        url VARCHAR,
        full_text_fetched_at TIMESTAMPTZ,
        full_text VARCHAR,
        full_text_html VARCHAR,
        full_text_source VARCHAR,
        full_text_original_format VARCHAR,
        full_text_pdf VARCHAR,
        full_text_assets JSON,
        full_text_conversion_status VARCHAR,
        full_text_conversion_error VARCHAR,
        full_text_conversion_attempts INTEGER,
        full_text_char_count BIGINT,
        content_hash VARCHAR,
        import_route VARCHAR,
        original_data JSON,
        source_metadata JSON,
        publication_status VARCHAR
      );
      INSERT INTO app.project (id, model_id, date_from, use_title, use_abstract, use_fulltext, use_fulltext_no_images)
      VALUES ('project-1', 'model-1', '2024-01-01T00:00:00Z', TRUE, TRUE, FALSE, FALSE);
      INSERT INTO app.prompt (id, original_text, prompt_heading, type) VALUES ('prompt-1', 'Prompt body', 'Prompt heading', 'string');
      INSERT INTO app.project_prompt (id, project_id, prompt_id, prompt_order, enabled) VALUES ('pp-1', 'project-1', 'prompt-1', 2, TRUE);
      INSERT INTO app.project_import_route (id, project_id, import_route_id) VALUES ('pir-1', 'project-1', 'route-1');
      INSERT INTO app.article (id, article_title, article_authors, article_created_at, article_id, full_text_pdf, original_data, source_metadata)
      VALUES ('article-1', 'Article 1', ['Alice', 'Bob'], '2024-01-02T00:00:00Z', 'A-1', '/tmp/a.pdf', '{"journalInfo":{"title":"J1"}}', '{"journalTitle":"J1","preprintSource":null,"preprintHostLabel":null,"isPreprint":false,"fullTextLinks":[]}');
    `,
  ])

  if (init.exitCode !== 0) {
    throw new Error(init.stderr.toString() || init.stdout.toString() || 'Failed to initialize DuckDB test database')
  }

  try {
    const result = globalThis.Bun.spawnSync(
      [
        'bun',
        '-e',
        `
          const {getAppQueryService} = await import('./src/server/services/getAppQueryService.ts')
          const {getAppDatabaseService} = await import('./src/server/services/appDatabaseService.ts')
          const service = getAppQueryService()
          const [promptRow] = await service.getProjectPromptRows('project-1')
          const projectConfig = await service.getProjectReviewConfig('project-1')
          const [reviewHydrationRow] = await service.getReviewHydrationRows(['article-1'])
          const [fullArticleRow] = await service.getFullArticlesByIds(['article-1'])
          console.log(JSON.stringify({promptRow, projectConfig, reviewHydrationRow, fullArticleRow}))
          await getAppDatabaseService().close()
        `,
      ],
      {
        cwd: process.cwd(),
        env: {...process.env, API_SERVER_PORT: '39991', DUCKDB_PATH: duckdbPath, SERVER_ROLE: 'maintenance-worker'},
      },
    )

    if (result.exitCode !== 0) {
      throw new Error(
        result.stderr.toString() || result.stdout.toString() || 'Failed to query app service test database',
      )
    }

    const parsed = JSON.parse(result.stdout.toString()) as {
      promptRow: {id: string; promptHeading: string; originalText: string; type: string}
      projectConfig: {
        dateFrom: string
        dateTo: string | null
        humanJudgmentMode: 'prompt' | 'summary'
        importRouteIds: string[]
        modelId: string
        useTitle: boolean
        useAbstract: boolean
        useFulltext: boolean
        useFulltextNoImages: boolean
      }
      reviewHydrationRow: {
        articleId: string
        fullTextPDF: string
        sourceMetadata: {
          journalTitle: string
          preprintSource: string | null
          preprintHostLabel: string | null
          isPreprint: boolean
          fullTextLinks: []
          covidence: null
        }
      }
      fullArticleRow: {articleAuthors: string[]}
    }

    expect(parsed.promptRow).toEqual({
      id: 'prompt-1',
      promptHeading: 'Prompt heading',
      originalText: 'Prompt body',
      type: 'string',
    })
    expect(parsed.projectConfig).toEqual({
      dateFrom: '2024-01-01T00:00:00.000Z',
      dateTo: null,
      humanJudgmentMode: 'prompt',
      importRouteIds: ['route-1'],
      modelId: 'model-1',
      useTitle: true,
      useAbstract: true,
      useFulltext: false,
      useFulltextNoImages: false,
    })
    expect(parsed.reviewHydrationRow.articleId).toBe('A-1')
    expect(parsed.reviewHydrationRow.fullTextPDF).toBe('/tmp/a.pdf')
    expect(parsed.reviewHydrationRow.sourceMetadata).toEqual({
      journalTitle: 'J1',
      preprintSource: null,
      preprintHostLabel: null,
      isPreprint: false,
      fullTextLinks: [],
      covidence: null,
    })
    expect(parsed.fullArticleRow.articleAuthors).toEqual(['Alice', 'Bob'])
  } finally {
    removeFileIfExists(duckdbPath)
  }
})

test('read-only app query helpers read DuckDB without accepting write-capable SQL', async () => {
  const duckdbPath = `/tmp/f1-read-only-app-query-service-${Date.now()}.duckdb`
  const init = globalThis.Bun.spawnSync([
    'duckdb',
    '-json',
    duckdbPath,
    `
      CREATE SCHEMA app;
      CREATE TABLE app.sample (value INTEGER NOT NULL);
      INSERT INTO app.sample (value) VALUES (42);
    `,
  ])

  if (init.exitCode !== 0) {
    throw new Error(init.stderr.toString() || init.stdout.toString() || 'Failed to initialize read-only DuckDB test')
  }

  try {
    const result = globalThis.Bun.spawnSync(
      [
        'bun',
        '-e',
        `
          const {getJudgeWorkerReadOnlyAppDatabaseService, closeAppReadOnlyDatabaseServices} = await import('./src/server/services/appReadOnlyDatabaseService.ts')
          const database = getJudgeWorkerReadOnlyAppDatabaseService()
          const rows = await database.queryJson('SELECT value FROM app.sample LIMIT 1')
          let writeError = null
          try {
            await database.queryJson('UPDATE app.sample SET value = 43 RETURNING value')
          } catch (error) {
            writeError = error instanceof Error ? error.message : String(error)
          }
          console.log(JSON.stringify({rows, writeError}))
          await closeAppReadOnlyDatabaseServices()
        `,
      ],
      {
        cwd: process.cwd(),
        env: {...process.env, API_SERVER_PORT: '39992', DUCKDB_PATH: duckdbPath, SERVER_ROLE: 'judge-worker'},
      },
    )

    if (result.exitCode !== 0) {
      throw new Error(result.stderr.toString() || result.stdout.toString() || 'Failed to run read-only query test')
    }

    const parsed = JSON.parse(result.stdout.toString()) as {rows: Array<{value: number}>; writeError: string | null}

    expect(parsed.rows).toEqual([{value: 42}])
    expect(parsed.writeError).toContain('read-only DuckDB helper rejected a write-capable statement')
  } finally {
    removeFileIfExists(duckdbPath)
  }
})

test('audited read-only modules do not import owner-capable database helpers', () => {
  const auditedFiles = [
    'src/server/services/appReadOnlyDatabaseService.ts',
    'src/server/services/getAppReadOnlyQueryService.ts',
    'src/server/routes/promptsRoutes/promptsRoutesReadOnly.ts',
    'src/server/cron/judgmentsJobs/judgmentsJobsSendToLLM/getAndUpdateReadyPrompts.ts',
    'src/server/cron/judgmentsJobs/judgmentsJobsSendToLLM/processPromptWithLLM.ts',
    'src/server/cron/judgmentsJobs/judgmentsJobsAddToQueue.ts',
    'src/server/cron/judgmentsJobs/judgmentsJobsAddToQueueDependencies.ts',
    'src/server/cron/judgmentsJobs/judgmentsJobsGetRunningJobs.ts',
    'src/server/cron/judgmentsJobs/judgmentsJobsCronGetPrompts.ts',
    'src/server/cron/judgmentsJobs/judgmentsJobsCleanupStale.ts',
  ]
  const forbiddenImports = ['appDatabaseService', 'getAppQueryService']
  const violations = auditedFiles.flatMap((filePath) => {
    const source = readFileSync(filePath, 'utf8')

    return forbiddenImports
      .filter((forbiddenImport) => {
        return source.includes(forbiddenImport)
      })
      .map((forbiddenImport) => {
        return `${filePath}:${forbiddenImport}`
      })
  })

  expect(violations).toEqual([])
})
