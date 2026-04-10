import {existsSync, unlinkSync} from 'node:fs'

import {expect, test} from 'bun:test'

const removeFileIfExists = (filePath: string) => {
  if (existsSync(filePath)) {
    unlinkSync(filePath)
  }
}

test('storeImportedArticlesWithTx upserts articles in DuckDB without current_timestamp binder errors', async () => {
  const duckdbPath = `/tmp/f1-article-import-store-${Date.now()}.duckdb`
  const result = globalThis.Bun.spawnSync(
    [
      'bun',
      '-e',
      `
        const [{migrateDuckdb}, {resetDuckdbServiceForTests}, {resetServerRuntimeRoleForTests}, {getAppDatabaseService}, {storeImportedArticlesWithTx}] = await Promise.all([
          import('./src/db/migrateDuckdb.ts'),
          import('./src/server/utils/duckdbService.ts'),
          import('./src/server/utils/serverRuntimeRole.ts'),
          import('./src/server/services/appDatabaseService.ts'),
          import('./src/server/services/articleImportStoreService.ts'),
        ])

        resetDuckdbServiceForTests()
        resetServerRuntimeRoleForTests()
        await migrateDuckdb()

        const database = getAppDatabaseService()
        const importRoute = 'structured-file:test-import'

        const createRow = (articleTitle, updatedAt) => ({
          articleAuthors: ['Alice Example'],
          articleCreatedAt: new Date('2026-01-01T00:00:00.000Z'),
          articleId: 'structured-file-article-1',
          articleSummary: 'Structured import summary',
          articleTitle,
          articleUpdatedAt: new Date(updatedAt),
          fullText: 'Structured import full text',
          fullTextCharCount: 27,
          fullTextConversionAttempts: 1,
          fullTextConversionStatus: 'success',
          fullTextFetchedAt: new Date(updatedAt),
          fullTextOriginalFormat: 'json',
          fullTextSource: 'structured_file_import',
          importRoute,
          sourceMetadata: {
            structuredFile: {
              assetPath: 'assets/structured_file_imports/test.json',
              boundaryDisplayPath: '$.records[]',
              boundaryPointer: '/records',
              format: 'json',
              sourceFileName: 'test.json',
            },
          },
        })

        await database.transaction(async (tx) => {
          await storeImportedArticlesWithTx(tx, [createRow('Initial title', '2026-01-02T00:00:00.000Z')])
        })

        const [articleRow] = await database.queryJson(
          "SELECT article_title AS articleTitle, article_updated_at AS articleUpdatedAt FROM app.article WHERE article_id = 'structured-file-article-1'"
        )
        const [articleCountRow] = await database.queryJson(
          "SELECT COUNT(*)::INTEGER AS count FROM app.article WHERE article_id = 'structured-file-article-1'"
        )
        const [importRouteRow] = await database.queryJson(
          "SELECT route FROM app.import_route WHERE route = 'structured-file:test-import'"
        )
        const [articleImportRouteCountRow] = await database.queryJson(
          "SELECT COUNT(*)::INTEGER AS count FROM app.article_import_route air INNER JOIN app.article a ON a.id = air.article_id INNER JOIN app.import_route ir ON ir.id = air.import_route_id WHERE a.article_id = 'structured-file-article-1' AND ir.route = 'structured-file:test-import'"
        )

        console.log(JSON.stringify({articleRow, articleCountRow, importRouteRow, articleImportRouteCountRow}))
        await database.close()
      `,
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        API_SERVER_PORT: '39991',
        DUCKDB_PATH: duckdbPath,
        SERVER_ROLE: 'dev-single',
        VITE_PORT: '39992',
      },
    },
  )

  try {
    if (result.exitCode !== 0) {
      throw new Error(result.stderr.toString() || result.stdout.toString() || 'Failed to store imported articles')
    }

    const stdoutLines = result.stdout
      .toString()
      .split('\n')
      .map((line) => {
        return line.trim()
      })
      .filter((line) => {
        return line.length > 0
      })
    const parsed = JSON.parse(stdoutLines.at(-1) ?? '{}') as {
      articleRow: {articleTitle: string; articleUpdatedAt: string | null}
      articleCountRow: {count: number}
      importRouteRow: {route: string}
      articleImportRouteCountRow: {count: number}
    }

    expect(parsed.articleRow.articleTitle).toBe('Initial title')
    expect(new Date(parsed.articleRow.articleUpdatedAt ?? '').toISOString()).toBe('2026-01-02T00:00:00.000Z')
    expect(parsed.articleCountRow.count).toBe(1)
    expect(parsed.importRouteRow).toEqual({route: 'structured-file:test-import'})
    expect(parsed.articleImportRouteCountRow.count).toBe(1)
  } finally {
    removeFileIfExists(duckdbPath)
    removeFileIfExists(`${duckdbPath}.wal`)
    removeFileIfExists(`${duckdbPath}.writer.lock`)
    removeFileIfExists(`${duckdbPath}.writer.history.json`)
  }
})

test('storeImportedArticlesWithTx reimports referenced articles without foreign key errors', async () => {
  const duckdbPath = `/tmp/f1-article-import-store-update-${Date.now()}.duckdb`
  const result = globalThis.Bun.spawnSync(
    [
      'bun',
      '-e',
      `
        const [{migrateDuckdb}, {resetDuckdbServiceForTests}, {resetServerRuntimeRoleForTests}, {getAppDatabaseService}, {storeImportedArticlesWithTx}] = await Promise.all([
          import('./src/db/migrateDuckdb.ts'),
          import('./src/server/utils/duckdbService.ts'),
          import('./src/server/utils/serverRuntimeRole.ts'),
          import('./src/server/services/appDatabaseService.ts'),
          import('./src/server/services/articleImportStoreService.ts'),
        ])

        resetDuckdbServiceForTests()
        resetServerRuntimeRoleForTests()
        await migrateDuckdb()

        const database = getAppDatabaseService()
        const importRoute = '/api/datasources/import/pubmed'
        const createRow = (articleTitle) => ({
          articleAuthors: ['Alice Example'],
          articleCreatedAt: new Date('2026-01-01T00:00:00.000Z'),
          articleId: 'pmid:referenced-article-1',
          articleSummary: 'PubMed summary',
          articleTitle,
          articleUpdatedAt: new Date('2026-01-02T00:00:00.000Z'),
          importRoute,
          pubmedId: 'referenced-article-1',
        })

        await database.transaction(async (tx) => {
          await storeImportedArticlesWithTx(tx, [createRow('Initial title')])
        })

        const [articleRow] = await database.queryJson(
          "SELECT id, article_title AS articleTitle FROM app.article WHERE article_id = 'pmid:referenced-article-1'"
        )

        await database.run(
          "INSERT INTO app.model (id, provider_connection_id, name, remote_model_id, display_name, source, enabled) VALUES ('article-import-model-1', 'provider-connection-1', 'Article Import Model', 'article-import-model-1', 'Article Import Model', 'manual', TRUE)"
        )

        await database.run(
          "INSERT INTO app.project (id, name, model_id, use_title, use_abstract, use_fulltext, use_fulltext_no_images) VALUES ('article-import-project-1', 'Article Import Project', 'article-import-model-1', TRUE, TRUE, FALSE, FALSE)"
        )
        await database.run(
          "INSERT INTO app.project_article (id, project_id, article_id) VALUES ('article-import-project-article-1', 'article-import-project-1', '"
          + articleRow.id
          + "')"
        )

        await database.transaction(async (tx) => {
          await storeImportedArticlesWithTx(tx, [createRow('Updated title')])
        })

        const [updatedArticleRow] = await database.queryJson(
          "SELECT id, article_title AS articleTitle FROM app.article WHERE article_id = 'pmid:referenced-article-1'"
        )
        const [articleImportRouteCountRow] = await database.queryJson(
          "SELECT COUNT(*)::INTEGER AS count FROM app.article_import_route WHERE article_id = '" + articleRow.id + "'"
        )
        const [projectArticleCountRow] = await database.queryJson(
          "SELECT COUNT(*)::INTEGER AS count FROM app.project_article WHERE article_id = '" + articleRow.id + "'"
        )

        console.log(JSON.stringify({articleImportRouteCountRow, articleRow, projectArticleCountRow, updatedArticleRow}))
        await database.close()
      `,
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        API_SERVER_PORT: '39991',
        DUCKDB_PATH: duckdbPath,
        SERVER_ROLE: 'dev-single',
        VITE_PORT: '39992',
      },
    },
  )

  try {
    if (result.exitCode !== 0) {
      throw new Error(
        result.stderr.toString() || result.stdout.toString() || 'Failed to update referenced imported article',
      )
    }

    const stdoutLines = result.stdout
      .toString()
      .split('\n')
      .map((line) => {
        return line.trim()
      })
      .filter((line) => {
        return line.length > 0
      })
    const parsed = JSON.parse(stdoutLines.at(-1) ?? '{}') as {
      articleImportRouteCountRow: {count: number}
      articleRow: {articleTitle: string; id: string}
      projectArticleCountRow: {count: number}
      updatedArticleRow: {articleTitle: string; id: string}
    }

    expect(parsed.updatedArticleRow.articleTitle).toBe('Initial title')
    expect(parsed.updatedArticleRow.id).toBe(parsed.articleRow.id)
    expect(parsed.articleImportRouteCountRow.count).toBe(1)
    expect(parsed.projectArticleCountRow.count).toBe(1)
  } finally {
    removeFileIfExists(duckdbPath)
    removeFileIfExists(`${duckdbPath}.wal`)
    removeFileIfExists(`${duckdbPath}.writer.lock`)
    removeFileIfExists(`${duckdbPath}.writer.history.json`)
  }
})
