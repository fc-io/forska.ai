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
          doi: '10.1000/structured-article-1',
          fullText: 'Structured import full text',
          fullTextCharCount: 27,
          fullTextConversionAttempts: 1,
          fullTextConversionStatus: 'success',
          fullTextFetchedAt: new Date(updatedAt),
          fullTextHtml: '<p>Structured import full text</p>',
          fullTextOriginalFormat: 'json',
          fullTextPDF: 'assets/structured_file_imports/test.pdf',
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
          "SELECT article.article_id AS legacyArticleId, article.article_title AS articleTitle, article.full_text AS fullText, article.full_text_html AS fullTextHtml, article.full_text_pdf AS fullTextPDF, article.full_text_source AS fullTextSource, article.full_text_original_format AS fullTextOriginalFormat, article.full_text_fetched_at IS NOT NULL AS hasFullTextFetchedAt, article.full_text_conversion_status AS fullTextConversionStatus, article.full_text_conversion_attempts AS fullTextConversionAttempts, article.full_text_char_count AS fullTextCharCount FROM app.article article INNER JOIN app.article_identifier identifier ON identifier.article_id = article.id WHERE identifier.kind = 'doi' AND identifier.normalized_value = '10.1000/structured-article-1'"
        )
        const [articleCountRow] = await database.queryJson(
          "SELECT COUNT(*)::INTEGER AS count FROM app.article article INNER JOIN app.article_identifier identifier ON identifier.article_id = article.id WHERE identifier.kind = 'doi' AND identifier.normalized_value = '10.1000/structured-article-1'"
        )
        const [importRouteRow] = await database.queryJson(
          "SELECT route FROM app.import_route WHERE route = 'structured-file:test-import'"
        )
        const [articleImportRouteCountRow] = await database.queryJson(
          "SELECT COUNT(*)::INTEGER AS count FROM app.article_import_route air INNER JOIN app.import_route ir ON ir.id = air.import_route_id WHERE air.external_article_id = 'structured-file-article-1' AND ir.route = 'structured-file:test-import'"
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
      articleRow: {articleTitle: string; legacyArticleId: string | null}
      articleCountRow: {count: number}
      importRouteRow: {route: string}
      articleImportRouteCountRow: {count: number}
    }

    expect(parsed.articleRow.articleTitle).toBe('Initial title')
    expect(parsed.articleRow.legacyArticleId).toBeNull()
    expect(parsed.articleRow).toMatchObject({
      fullText: 'Structured import full text',
      fullTextCharCount: '27',
      fullTextConversionAttempts: 1,
      fullTextConversionStatus: 'success',
      fullTextHtml: '<p>Structured import full text</p>',
      fullTextOriginalFormat: 'json',
      fullTextPDF: 'assets/structured_file_imports/test.pdf',
      fullTextSource: 'structured_file_import',
      hasFullTextFetchedAt: true,
    })
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

test('storeImportedArticlesWithTx collapses duplicate strong identifiers into one canonical article', async () => {
  const duckdbPath = `/tmp/f1-article-import-duplicate-identifier-${Date.now()}.duckdb`
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
        const importRoute = 'structured-file:duplicate-identifier'
        const createRow = (params) => ({
          articleAuthors: ['Alice Example'],
          articleId: params.articleId,
          articleSummary: 'Duplicate identifier summary',
          articleTitle: params.articleTitle,
          doi: params.doi,
          importRoute,
          sourceKind: 'structured_file',
          sourceRecordHash: params.sourceRecordHash,
          sourceRecordKey: params.sourceRecordKey,
        })

        await database.transaction(async (tx) => {
          await storeImportedArticlesWithTx(tx, [
            createRow({
              articleId: 'external-duplicate-a',
              articleTitle: 'Duplicate title A',
              doi: 'https://doi.org/10.1000/duplicate-import',
              sourceRecordHash: 'hash-duplicate-a',
              sourceRecordKey: 'source-duplicate-a',
            }),
            createRow({
              articleId: 'external-duplicate-b',
              articleTitle: 'Duplicate title B',
              doi: '10.1000/duplicate-import',
              sourceRecordHash: 'hash-duplicate-b',
              sourceRecordKey: 'source-duplicate-b',
            }),
          ])
        })

        const [articleCountRow] = await database.queryJson(
          "SELECT COUNT(*)::INTEGER AS count FROM app.article"
        )
        const identifierRows = await database.queryJson(
          "SELECT kind, normalized_value AS normalizedValue FROM app.article_identifier ORDER BY kind ASC, normalized_value ASC"
        )
        const sourceRecordRows = await database.queryJson(
          "SELECT external_article_id AS externalArticleId, source_record_key AS sourceRecordKey FROM app.article_import_route_source_record ORDER BY source_record_key ASC"
        )
        const [currentLinkCountRow] = await database.queryJson(
          "SELECT COUNT(*)::INTEGER AS count FROM app.article_import_route"
        )

        console.log(JSON.stringify({articleCountRow, currentLinkCountRow, identifierRows, sourceRecordRows}))
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
        result.stderr.toString() || result.stdout.toString() || 'Failed to collapse duplicate identifiers',
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
      articleCountRow: {count: number}
      currentLinkCountRow: {count: number}
      identifierRows: Array<{kind: string; normalizedValue: string}>
      sourceRecordRows: Array<{externalArticleId: string; sourceRecordKey: string}>
    }

    expect(parsed.articleCountRow.count).toBe(1)
    expect(parsed.currentLinkCountRow.count).toBe(1)
    expect(parsed.identifierRows).toEqual([{kind: 'doi', normalizedValue: '10.1000/duplicate-import'}])
    expect(parsed.sourceRecordRows).toEqual([
      {externalArticleId: 'external-duplicate-a', sourceRecordKey: 'source-duplicate-a'},
      {externalArticleId: 'external-duplicate-b', sourceRecordKey: 'source-duplicate-b'},
    ])
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
          doi: params.doi,
          externalArticleId: params.externalArticleId,
          importMetadata: {batch: params.batch},
          importRoute,
          importRunId: params.importRunId,
          matchMetadata: {mode: 'canonical'},
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
              doi: '10.1000/source-record-a',
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
              doi: '10.1000/source-record-a',
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
              doi: '10.1000/source-record-a',
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
              doi: '10.1000/source-record-remap',
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
          "SELECT air.external_article_id AS externalArticleId, air.source_kind AS sourceKind, air.source_record_hash AS sourceRecordHash, json_extract_string(air.import_metadata, '$.batch') AS batch, json_extract_string(air.raw_payload, '$.version') AS payloadVersion FROM app.article_import_route air WHERE air.external_article_id = 'external-a'"
        )
        const [remapLinkCountRow] = await database.queryJson(
          "SELECT COUNT(*)::INTEGER AS count FROM app.article_import_route air WHERE air.external_article_id = 'external-remap'"
        )
        const [articleCountRow] = await database.queryJson(
          "SELECT COUNT(*)::INTEGER AS count FROM app.article"
        )
        const identifierRows = await database.queryJson(
          "SELECT kind, normalized_value AS normalizedValue FROM app.article_identifier ORDER BY kind ASC, normalized_value ASC"
        )

        console.log(JSON.stringify({articleCountRow, currentLinkRow, identifierRows, remapLinkCountRow, sourceRecordCountRow, sourceRecordRow}))
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
      articleCountRow: {count: number}
      currentLinkRow: {
        batch: string
        externalArticleId: string
        payloadVersion: string
        sourceKind: string
        sourceRecordHash: string
      }
      identifierRows: Array<{kind: string; normalizedValue: string}>
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
    expect(parsed.articleCountRow.count).toBe(1)
    expect(parsed.identifierRows).toEqual([{kind: 'doi', normalizedValue: '10.1000/source-record-a'}])
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

test('storeImportedArticlesWithTx quarantines source-row identifier conflicts before matching', async () => {
  const duckdbPath = `/tmp/f1-article-import-identifier-conflict-${Date.now()}.duckdb`
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
        const importRoute = 'structured-file:identifier-conflict-test'
        const createRow = (params) => ({
          allowUnidentifiedCreate: true,
          articleAuthors: ['Alice Example'],
          articleId: params.articleId,
          articleSummary: 'Identifier conflict summary',
          articleTitle: params.articleTitle,
          biorxivId: params.biorxivId ?? null,
          doi: params.doi ?? null,
          externalArticleId: params.externalArticleId,
          importRoute,
          importRunId: 'identifier-conflict-run',
          pubmedId: params.pubmedId ?? null,
          sourceKind: 'structured_file',
          sourceRecordHash: params.sourceRecordHash,
          sourceRecordKey: params.sourceRecordKey,
        })

        await database.transaction(async (tx) => {
          await storeImportedArticlesWithTx(tx, [
            createRow({
              articleId: 'source-row-conflict',
              articleTitle: 'Conflicting DOI row',
              biorxivId: 'https://www.biorxiv.org/content/10.1101/2024.01.01.123456v1',
              doi: '10.1000/source-row-conflict',
              externalArticleId: 'external-conflict',
              sourceRecordHash: 'hash-conflict',
              sourceRecordKey: 'source-row-conflict',
            }),
            createRow({
              articleId: 'source-row-malformed',
              articleTitle: 'Malformed PMID row',
              externalArticleId: 'external-malformed',
              pubmedId: '12A',
              sourceRecordHash: 'hash-malformed',
              sourceRecordKey: 'source-row-malformed',
            }),
          ])
        })

        const [articleCountRow] = await database.queryJson(
          "SELECT COUNT(*)::INTEGER AS count FROM app.article"
        )
        const [identifierCountRow] = await database.queryJson(
          "SELECT COUNT(*)::INTEGER AS count FROM app.article_identifier"
        )
        const [sourceRecordCountRow] = await database.queryJson(
          "SELECT COUNT(*)::INTEGER AS count FROM app.article_import_route_source_record"
        )
        const [currentLinkCountRow] = await database.queryJson(
          "SELECT COUNT(*)::INTEGER AS count FROM app.article_import_route"
        )
        const quarantineRows = await database.queryJson(
          "SELECT source_record_key AS sourceRecordKey, kind, normalized_value AS normalizedValue, reason FROM app.article_canonical_match_quarantine ORDER BY source_record_key ASC, kind ASC, normalized_value ASC"
        )

        console.log(JSON.stringify({articleCountRow, currentLinkCountRow, identifierCountRow, quarantineRows, sourceRecordCountRow}))
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
        result.stderr.toString() || result.stdout.toString() || 'Failed to quarantine identifier conflicts',
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
      articleCountRow: {count: number}
      currentLinkCountRow: {count: number}
      identifierCountRow: {count: number}
      quarantineRows: Array<{kind: string; normalizedValue: string; reason: string; sourceRecordKey: string}>
      sourceRecordCountRow: {count: number}
    }

    expect(parsed.articleCountRow.count).toBe(0)
    expect(parsed.identifierCountRow.count).toBe(0)
    expect(parsed.sourceRecordCountRow.count).toBe(0)
    expect(parsed.currentLinkCountRow.count).toBe(0)
    expect(parsed.quarantineRows).toEqual([
      {
        kind: 'doi',
        normalizedValue: '10.1000/source-row-conflict',
        reason: 'source-row-identifier-disagreement',
        sourceRecordKey: 'source-row-conflict',
      },
      {
        kind: 'doi',
        normalizedValue: '10.1101/2024.01.01.123456',
        reason: 'source-row-identifier-disagreement',
        sourceRecordKey: 'source-row-conflict',
      },
      {
        kind: 'pmid',
        normalizedValue: '12A',
        reason: 'source-row-identifier-malformed',
        sourceRecordKey: 'source-row-malformed',
      },
    ])
  } finally {
    removeFileIfExists(duckdbPath)
    removeFileIfExists(`${duckdbPath}.wal`)
    removeFileIfExists(`${duckdbPath}.duckdb-owner.lock`)
    removeFileIfExists(`${duckdbPath}.duckdb-owner.history.json`)
  }
})

test('syncImportedArticlesWithTx clears stale source records for the synced route', async () => {
  const duckdbPath = `/tmp/f1-article-import-source-record-sync-${Date.now()}.duckdb`
  const result = globalThis.Bun.spawnSync(
    [
      'bun',
      '-e',
      `
        const [{migrateDuckdb}, {resetDuckdbServiceForTests}, {resetServerRuntimeRoleForTests}, {getAppDatabaseService}, {syncImportedArticlesWithTx}] = await Promise.all([
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
        const importRoute = 'structured-file:source-record-sync'
        const createRow = (params) => ({
          articleAuthors: ['Alice Example'],
          articleId: params.articleId,
          articleSummary: 'Structured import summary',
          articleTitle: params.articleTitle,
          doi: params.doi,
          externalArticleId: params.externalArticleId,
          importRoute,
          sourceKind: 'structured_file',
          sourceRecordHash: params.sourceRecordHash,
          sourceRecordKey: params.sourceRecordKey,
        })

        await database.transaction(async (tx) => {
          await syncImportedArticlesWithTx({
            importRoute,
            rows: [
              createRow({
                articleId: 'sync-old-a',
                articleTitle: 'Sync Old A',
                doi: '10.1000/sync-old-a',
                externalArticleId: 'external-old-a',
                sourceRecordHash: 'hash-old-a',
                sourceRecordKey: 'source-old-a',
              }),
              createRow({
                articleId: 'sync-old-b',
                articleTitle: 'Sync Old B',
                doi: '10.1000/sync-old-b',
                externalArticleId: 'external-old-b',
                sourceRecordHash: 'hash-old-b',
                sourceRecordKey: 'source-old-b',
              }),
            ],
            tx,
          })
        })
        await database.transaction(async (tx) => {
          await syncImportedArticlesWithTx({
            importRoute,
            rows: [
              createRow({
                articleId: 'sync-new-a',
                articleTitle: 'Sync New A',
                doi: '10.1000/sync-new-a',
                externalArticleId: 'external-new-a',
                sourceRecordHash: 'hash-new-a',
                sourceRecordKey: 'source-new-a',
              }),
            ],
            tx,
          })
        })

        const currentLinkRows = await database.queryJson(
          "SELECT external_article_id AS externalArticleId, source_record_key AS sourceRecordKey FROM app.article_import_route ORDER BY source_record_key ASC"
        )
        const sourceRecordRows = await database.queryJson(
          "SELECT external_article_id AS externalArticleId, source_record_key AS sourceRecordKey FROM app.article_import_route_source_record ORDER BY source_record_key ASC"
        )

        console.log(JSON.stringify({currentLinkRows, sourceRecordRows}))
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
      throw new Error(result.stderr.toString() || result.stdout.toString() || 'Failed to sync import source records')
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
      currentLinkRows: Array<{externalArticleId: string; sourceRecordKey: string}>
      sourceRecordRows: Array<{externalArticleId: string; sourceRecordKey: string}>
    }

    expect(parsed.currentLinkRows).toEqual([{externalArticleId: 'external-new-a', sourceRecordKey: 'source-new-a'}])
    expect(parsed.sourceRecordRows).toEqual([{externalArticleId: 'external-new-a', sourceRecordKey: 'source-new-a'}])
  } finally {
    removeFileIfExists(duckdbPath)
    removeFileIfExists(`${duckdbPath}.wal`)
    removeFileIfExists(`${duckdbPath}.duckdb-owner.lock`)
    removeFileIfExists(`${duckdbPath}.duckdb-owner.history.json`)
  }
})

test('syncImportedArticlesWithTx reuses id-less source records across reimports', async () => {
  const duckdbPath = `/tmp/f1-article-import-idless-reimport-${Date.now()}.duckdb`
  const result = globalThis.Bun.spawnSync(
    [
      'bun',
      '-e',
      `
        const [{migrateDuckdb}, {resetDuckdbServiceForTests}, {resetServerRuntimeRoleForTests}, {getAppDatabaseService}, {syncImportedArticlesWithTx}] = await Promise.all([
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
        const importRoute = 'covidence:idless-reimport'
        const createRow = (articleTitle) => ({
          allowUnidentifiedCreate: true,
          articleAuthors: ['Alice Example'],
          articleId: 'covidence:1',
          articleSummary: 'ID-less import summary',
          articleTitle,
          externalArticleId: 'covidence:idless-reimport:1',
          importRoute,
          sourceKind: 'covidence',
          sourceRecordHash: articleTitle,
          sourceRecordKey: 'covidence:1',
        })

        await database.transaction(async (tx) => {
          await syncImportedArticlesWithTx({importRoute, rows: [createRow('Initial ID-less title')], tx})
        })
        await database.transaction(async (tx) => {
          await syncImportedArticlesWithTx({importRoute, rows: [createRow('Updated ID-less title')], tx})
        })

        const articleRows = await database.queryJson("SELECT id, article_title AS articleTitle FROM app.article ORDER BY id ASC")
        const sourceRecordRows = await database.queryJson("SELECT article_id AS articleId, external_article_id AS externalArticleId, source_record_key AS sourceRecordKey FROM app.article_import_route_source_record ORDER BY source_record_key ASC")
        const currentLinkRows = await database.queryJson("SELECT article_id AS articleId, external_article_id AS externalArticleId, source_record_key AS sourceRecordKey FROM app.article_import_route ORDER BY source_record_key ASC")

        console.log(JSON.stringify({articleRows, currentLinkRows, sourceRecordRows}))
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
      throw new Error(result.stderr.toString() || result.stdout.toString() || 'Failed to reimport ID-less article')
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
      articleRows: Array<{articleTitle: string; id: string}>
      currentLinkRows: Array<{articleId: string; externalArticleId: string; sourceRecordKey: string}>
      sourceRecordRows: Array<{articleId: string; externalArticleId: string; sourceRecordKey: string}>
    }
    const articleId = parsed.articleRows[0]?.id

    expect(parsed.articleRows).toHaveLength(1)
    expect(parsed.currentLinkRows).toEqual([
      {articleId, externalArticleId: 'covidence:idless-reimport:1', sourceRecordKey: 'covidence:1'},
    ])
    expect(parsed.sourceRecordRows).toEqual([
      {articleId, externalArticleId: 'covidence:idless-reimport:1', sourceRecordKey: 'covidence:1'},
    ])
  } finally {
    removeFileIfExists(duckdbPath)
    removeFileIfExists(`${duckdbPath}.wal`)
    removeFileIfExists(`${duckdbPath}.duckdb-owner.lock`)
    removeFileIfExists(`${duckdbPath}.duckdb-owner.history.json`)
  }
})

test('storeImportedArticlesWithTx resolves canonical fields without lower-trust last-writer overwrites', async () => {
  const duckdbPath = `/tmp/f1-article-import-canonical-resolver-${Date.now()}.duckdb`
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
        const createRow = (params) => ({
          articleAuthors: ['Alice Example'],
          articleId: 'canonical-resolver-article',
          articleSummary: params.summary,
          articleTitle: params.title,
          doi: '10.1000/canonical-resolver',
          importRoute: params.importRoute,
          pubmedId: params.pubmedId ?? null,
          sourceKind: params.sourceKind,
          sourceRecordKey: params.sourceRecordKey,
        })

        await database.transaction(async (tx) => {
          await storeImportedArticlesWithTx(tx, [
            createRow({
              importRoute: 'structured-file:canonical-resolver',
              sourceKind: 'structured_file',
              sourceRecordKey: 'structured-a',
              summary: 'Structured summary',
              title: 'Structured title',
            }),
          ])
        })
        await database.transaction(async (tx) => {
          await storeImportedArticlesWithTx(tx, [
            createRow({
              importRoute: '/api/datasources/import/pubmed',
              pubmedId: '12345',
              sourceKind: 'pubmed',
              sourceRecordKey: 'pubmed-a',
              summary: 'Publisher summary',
              title: 'PubMed title',
            }),
          ])
        })
        await database.transaction(async (tx) => {
          await storeImportedArticlesWithTx(tx, [
            createRow({
              importRoute: 'structured-file:canonical-resolver',
              sourceKind: 'structured_file',
              sourceRecordKey: 'structured-b',
              summary: 'Structured summary with later lower trust detail',
              title: 'Structured title with later lower trust detail',
            }),
          ])
        })

        const [articleRow] = await database.queryJson(
          "SELECT article.article_id AS legacyArticleId, article.article_title AS articleTitle, article.article_summary AS articleSummary, article.pubmed_id AS pubmedId, article.url, article.publication_status AS publicationStatus FROM app.article article INNER JOIN app.article_identifier identifier ON identifier.article_id = article.id WHERE identifier.kind = 'doi' AND identifier.normalized_value = '10.1000/canonical-resolver'"
        )

        console.log(JSON.stringify({articleRow}))
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
        result.stderr.toString() || result.stdout.toString() || 'Failed to resolve canonical article fields',
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
      articleRow: {
        articleSummary: string
        articleTitle: string
        legacyArticleId: string | null
        publicationStatus: string
        pubmedId: string
        url: string
      }
    }

    expect(parsed.articleRow).toEqual({
      articleSummary: 'Publisher summary',
      articleTitle: 'PubMed title',
      legacyArticleId: null,
      publicationStatus: 'published',
      pubmedId: '12345',
      url: 'https://doi.org/10.1000/canonical-resolver',
    })
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
          articleId: 'pmid:991001',
          articleSummary: 'PubMed summary',
          articleTitle,
          articleUpdatedAt: new Date('2026-01-02T00:00:00.000Z'),
          importRoute,
          pubmedId: '991001',
        })

        await database.transaction(async (tx) => {
          await storeImportedArticlesWithTx(tx, [createRow('Initial title')])
        })

        const [articleRow] = await database.queryJson(
          "SELECT article.id, article.article_title AS articleTitle FROM app.article article INNER JOIN app.article_identifier identifier ON identifier.article_id = article.id WHERE identifier.kind = 'pmid' AND identifier.normalized_value = '991001'"
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
          "SELECT article.id, article.article_title AS articleTitle FROM app.article article INNER JOIN app.article_identifier identifier ON identifier.article_id = article.id WHERE identifier.kind = 'pmid' AND identifier.normalized_value = '991001'"
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
