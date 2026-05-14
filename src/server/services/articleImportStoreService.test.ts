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
    removeFileIfExists(`${duckdbPath}.duckdb-owner.lock`)
    removeFileIfExists(`${duckdbPath}.duckdb-owner.history.json`)
  }
})

test('storeImportedArticlesWithTx keeps source records idempotent and quarantines remaps', async () => {
  const duckdbPath = `/tmp/f1-article-import-source-record-${Date.now()}.duckdb`
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
        const importRoute = 'structured-file:source-record-test'
        const createRow = (params) => ({
          articleAuthors: ['Alice Example'],
          articleId: params.articleId,
          articleSummary: 'Structured import summary',
          articleTitle: params.articleTitle,
          externalArticleId: params.externalArticleId,
          importMetadata: {batch: params.batch},
          importRoute,
          importRunId: params.importRunId,
          matchMetadata: {mode: 'legacy'},
          originalData: {version: params.version},
          rawPayload: {version: params.version},
          sourceKind: 'structured_file',
          sourceRecordHash: params.sourceRecordHash,
          sourceRecordKey: 'stable-source-key',
        })

        await database.transaction(async (tx) => {
          await storeImportedArticlesWithTx(tx, [
            createRow({
              articleId: 'structured-file-article-a',
              articleTitle: 'Initial title',
              batch: 1,
              externalArticleId: 'external-a',
              importRunId: 'run-a',
              sourceRecordHash: 'hash-a',
              version: 1,
            }),
          ])
        })
        await database.transaction(async (tx) => {
          await storeImportedArticlesWithTx(tx, [
            createRow({
              articleId: 'structured-file-article-a',
              articleTitle: 'Initial title',
              batch: 1,
              externalArticleId: 'external-a',
              importRunId: 'run-a',
              sourceRecordHash: 'hash-a',
              version: 1,
            }),
          ])
        })
        await database.transaction(async (tx) => {
          await storeImportedArticlesWithTx(tx, [
            createRow({
              articleId: 'structured-file-article-a',
              articleTitle: 'Changed payload title',
              batch: 2,
              externalArticleId: 'external-a',
              importRunId: 'run-b',
              sourceRecordHash: 'hash-b',
              version: 2,
            }),
          ])
        })
        await database.transaction(async (tx) => {
          await storeImportedArticlesWithTx(tx, [
            createRow({
              articleId: 'structured-file-article-remap',
              articleTitle: 'Remapped title',
              batch: 3,
              externalArticleId: 'external-remap',
              importRunId: 'run-c',
              sourceRecordHash: 'hash-c',
              version: 3,
            }),
          ])
        })

        const [sourceRecordCountRow] = await database.queryJson(
          "SELECT COUNT(*)::INTEGER AS count FROM app.article_import_route_source_record WHERE source_record_key = 'stable-source-key'"
        )
        const [sourceRecordRow] = await database.queryJson(
          "SELECT source_record_hash AS sourceRecordHash, import_run_id AS importRunId, json_extract_string(raw_payload, '$.version') AS payloadVersion, quarantine_reason AS quarantineReason, quarantined_at IS NOT NULL AS quarantined, json_extract_string(quarantine_metadata, '$.incomingExternalArticleId') AS incomingExternalArticleId FROM app.article_import_route_source_record WHERE source_record_key = 'stable-source-key'"
        )
        const [currentLinkRow] = await database.queryJson(
          "SELECT air.external_article_id AS externalArticleId, air.source_kind AS sourceKind, air.source_record_hash AS sourceRecordHash, json_extract_string(air.import_metadata, '$.batch') AS batch, json_extract_string(air.raw_payload, '$.version') AS payloadVersion FROM app.article_import_route air INNER JOIN app.article article ON article.id = air.article_id WHERE article.article_id = 'structured-file-article-a'"
        )
        const [remapLinkCountRow] = await database.queryJson(
          "SELECT COUNT(*)::INTEGER AS count FROM app.article_import_route air INNER JOIN app.article article ON article.id = air.article_id WHERE article.article_id = 'structured-file-article-remap'"
        )

        console.log(JSON.stringify({currentLinkRow, remapLinkCountRow, sourceRecordCountRow, sourceRecordRow}))
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
      throw new Error(result.stderr.toString() || result.stdout.toString() || 'Failed to store import source records')
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
      currentLinkRow: {
        batch: string
        externalArticleId: string
        payloadVersion: string
        sourceKind: string
        sourceRecordHash: string
      }
      remapLinkCountRow: {count: number}
      sourceRecordCountRow: {count: number}
      sourceRecordRow: {
        importRunId: string
        incomingExternalArticleId: string
        payloadVersion: string
        quarantineReason: string
        quarantined: boolean
        sourceRecordHash: string
      }
    }

    expect(parsed.sourceRecordCountRow.count).toBe(1)
    expect(parsed.sourceRecordRow.sourceRecordHash).toBe('hash-b')
    expect(parsed.sourceRecordRow.importRunId).toBe('run-b')
    expect(parsed.sourceRecordRow.payloadVersion).toBe('2')
    expect(parsed.sourceRecordRow.quarantined).toBe(true)
    expect(parsed.sourceRecordRow.quarantineReason).toBe('source_record_remap')
    expect(parsed.sourceRecordRow.incomingExternalArticleId).toBe('external-remap')
    expect(parsed.currentLinkRow).toEqual({
      batch: '2',
      externalArticleId: 'external-a',
      payloadVersion: '2',
      sourceKind: 'structured_file',
      sourceRecordHash: 'hash-b',
    })
    expect(parsed.remapLinkCountRow.count).toBe(0)
  } finally {
    removeFileIfExists(duckdbPath)
    removeFileIfExists(`${duckdbPath}.wal`)
    removeFileIfExists(`${duckdbPath}.duckdb-owner.lock`)
    removeFileIfExists(`${duckdbPath}.duckdb-owner.history.json`)
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
    removeFileIfExists(`${duckdbPath}.duckdb-owner.lock`)
    removeFileIfExists(`${duckdbPath}.duckdb-owner.history.json`)
  }
})
