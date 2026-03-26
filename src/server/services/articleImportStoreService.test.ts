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
