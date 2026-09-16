import {mkdtempSync, rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

import {expect, setDefaultTimeout, test} from 'bun:test'

setDefaultTimeout(120_000)

const withMigratedDuckdb = async <T>(operation: () => Promise<T>) => {
  const root = mkdtempSync(join(tmpdir(), 'forska-article-import-reconciliation-period-'))
  const duckdbPath = join(root, 'period.duckdb')
  const previousEnv = {
    API_SERVER_PORT: process.env.API_SERVER_PORT,
    DUCKDB_PATH: process.env.DUCKDB_PATH,
    FORSKA_DB_PATH: process.env.FORSKA_DB_PATH,
    SERVER_ROLE: process.env.SERVER_ROLE,
    VITE_PORT: process.env.VITE_PORT,
  }

  process.env.API_SERVER_PORT = '39991'
  process.env.DUCKDB_PATH = duckdbPath
  process.env.FORSKA_DB_PATH = duckdbPath
  process.env.SERVER_ROLE = 'dev-single'
  process.env.VITE_PORT = '39992'

  const [{migrateDuckdb}, {getAppDatabaseService}, {resetDuckdbServiceForTests}, {resetServerRuntimeRoleForTests}] =
    await Promise.all([
      import('../../db/migrateDuckdb.ts'),
      import('./appDatabaseService.ts'),
      import('../utils/duckdbService.ts'),
      import('../utils/serverRuntimeRole.ts'),
    ])

  resetDuckdbServiceForTests()
  resetServerRuntimeRoleForTests()
  await migrateDuckdb()

  try {
    return await operation()
  } finally {
    await getAppDatabaseService().close()
    resetDuckdbServiceForTests()
    resetServerRuntimeRoleForTests()

    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = value
      }
    }

    rmSync(root, {force: true, recursive: true})
  }
}

test('period reconciliation sync clears stale source records only inside the reconciled source-date period', async () => {
  await withMigratedDuckdb(async () => {
    const [{getAppDatabaseService}, {syncImportedArticlesForReconciliationPeriodWithTx}] = await Promise.all([
      import('./appDatabaseService.ts'),
      import('./articleImportStoreService.ts'),
    ])
    const database = getAppDatabaseService()
    const dataSourceId = 'datasource-period-reconciliation'
    const importRoute = '/api/datasources/import/pubmed'
    const createRow = (params: {
      articleCreatedAt: string
      articleId: string
      articleTitle: string
      doi: string
      externalArticleId: string
      sourceRecordHash: string
      sourceRecordKey: string
    }) => {
      return {
        articleAuthors: ['Alice Example'],
        articleCreatedAt: new Date(params.articleCreatedAt),
        articleId: params.articleId,
        articleSummary: 'PubMed import summary',
        articleTitle: params.articleTitle,
        doi: params.doi,
        externalArticleId: params.externalArticleId,
        importRoute,
        sourceKind: 'pubmed',
        sourceRecordHash: params.sourceRecordHash,
        sourceRecordKey: params.sourceRecordKey,
      }
    }

    await database.run(`
      INSERT INTO app.data_source (id, title, import_route, tracking_enabled, date_from)
      VALUES (
        '${dataSourceId}',
        'Period reconciliation source',
        '${importRoute}',
        TRUE,
        TIMESTAMPTZ '2026-01-01T00:00:00.000Z'
      )
    `)
    await database.transaction(async (tx) => {
      await syncImportedArticlesForReconciliationPeriodWithTx({
        importRoute,
        periodEnd: new Date('2026-08-01T00:00:00.000Z'),
        periodStart: new Date('2026-06-01T00:00:00.000Z'),
        rows: [
          createRow({
            articleCreatedAt: '2026-06-15T00:00:00.000Z',
            articleId: 'pmid:period-delete',
            articleTitle: 'Period Delete',
            doi: '10.1000/period-delete',
            externalArticleId: 'pmid:period-delete',
            sourceRecordHash: 'hash-period-delete',
            sourceRecordKey: 'pmid:period-delete',
          }),
          createRow({
            articleCreatedAt: '2026-07-15T00:00:00.000Z',
            articleId: 'pmid:period-keep',
            articleTitle: 'Period Keep',
            doi: '10.1000/period-keep',
            externalArticleId: 'pmid:period-keep',
            sourceRecordHash: 'hash-period-keep',
            sourceRecordKey: 'pmid:period-keep',
          }),
        ],
        tx,
      })
    })
    await database.transaction(async (tx) => {
      await syncImportedArticlesForReconciliationPeriodWithTx({
        changeLogContext: {
          dataSourceId,
          importRunId: 'reconciliation-run-1',
          route: importRoute,
          runKind: 'automatic_age_bucket',
        },
        importRoute,
        periodEnd: new Date('2026-07-01T00:00:00.000Z'),
        periodStart: new Date('2026-06-01T00:00:00.000Z'),
        rows: [],
        tx,
      })
    })

    const currentLinkRows = await database.queryJson<{externalArticleId: string; sourceRecordKey: string}>(`
      SELECT external_article_id AS externalArticleId, source_record_key AS sourceRecordKey
      FROM app.article_import_route
      ORDER BY source_record_key ASC
    `)
    const sourceRecordRows = await database.queryJson<{externalArticleId: string; sourceRecordKey: string}>(`
      SELECT external_article_id AS externalArticleId, source_record_key AS sourceRecordKey
      FROM app.article_import_route_source_record
      ORDER BY source_record_key ASC
    `)
    const changeLogRows = await database.queryJson<{
      changeKind: string
      externalArticleId: string
      importRunId: string
      previousSourceRecordHash: string
      sourceRecordKey: string
    }>(`
      SELECT
        external_article_id AS externalArticleId,
        import_run_id AS importRunId,
        previous_source_record_hash AS previousSourceRecordHash,
        source_record_key AS sourceRecordKey,
        change_kind AS changeKind
      FROM app.data_source_article_change_log
      ORDER BY source_record_key ASC
    `)

    expect(currentLinkRows).toEqual([{externalArticleId: 'pmid:period-keep', sourceRecordKey: 'pmid:period-keep'}])
    expect(sourceRecordRows).toEqual([{externalArticleId: 'pmid:period-keep', sourceRecordKey: 'pmid:period-keep'}])
    expect(changeLogRows).toEqual([
      {
        changeKind: 'source_record_deleted',
        externalArticleId: 'pmid:period-delete',
        importRunId: 'reconciliation-run-1',
        previousSourceRecordHash: 'hash-period-delete',
        sourceRecordKey: 'pmid:period-delete',
      },
    ])
  })
})

test('period reconciliation sync logs source record changes and restorations', async () => {
  await withMigratedDuckdb(async () => {
    const [{getAppDatabaseService}, {syncImportedArticlesForReconciliationPeriodWithTx}] = await Promise.all([
      import('./appDatabaseService.ts'),
      import('./articleImportStoreService.ts'),
    ])
    const database = getAppDatabaseService()
    const dataSourceId = 'datasource-period-reconciliation-change'
    const importRoute = '/api/datasources/import/pubmed'
    const createRow = (params: {articleTitle: string; sourceRecordHash: string}) => {
      return {
        articleAuthors: ['Alice Example'],
        articleCreatedAt: new Date('2026-06-15T00:00:00.000Z'),
        articleId: 'pmid:period-change',
        articleSummary: 'PubMed import summary',
        articleTitle: params.articleTitle,
        doi: '10.1000/period-change',
        externalArticleId: 'pmid:period-change',
        importRoute,
        sourceKind: 'pubmed',
        sourceRecordHash: params.sourceRecordHash,
        sourceRecordKey: 'pmid:period-change',
      }
    }
    const runPeriodSync = async (params: {importRunId: string; rows: ReturnType<typeof createRow>[]}) => {
      await database.transaction(async (tx) => {
        await syncImportedArticlesForReconciliationPeriodWithTx({
          changeLogContext: {
            dataSourceId,
            importRunId: params.importRunId,
            route: importRoute,
            runKind: 'automatic_age_bucket',
          },
          importRoute,
          periodEnd: new Date('2026-07-01T00:00:00.000Z'),
          periodStart: new Date('2026-06-01T00:00:00.000Z'),
          rows: params.rows,
          tx,
        })
      })
    }

    await database.run(`
      INSERT INTO app.data_source (id, title, import_route, tracking_enabled, date_from)
      VALUES (
        '${dataSourceId}',
        'Period reconciliation source changes',
        '${importRoute}',
        TRUE,
        TIMESTAMPTZ '2026-01-01T00:00:00.000Z'
      )
    `)
    await runPeriodSync({
      importRunId: 'reconciliation-run-initial',
      rows: [createRow({articleTitle: 'Original source record', sourceRecordHash: 'hash-original'})],
    })
    await runPeriodSync({
      importRunId: 'reconciliation-run-changed',
      rows: [createRow({articleTitle: 'Changed source record', sourceRecordHash: 'hash-changed'})],
    })
    await runPeriodSync({importRunId: 'reconciliation-run-deleted', rows: []})
    await runPeriodSync({
      importRunId: 'reconciliation-run-restored',
      rows: [createRow({articleTitle: 'Restored source record', sourceRecordHash: 'hash-restored'})],
    })

    const sourceRecordRows = await database.queryJson<{sourceRecordHash: string; sourceRecordKey: string}>(`
      SELECT source_record_hash AS sourceRecordHash, source_record_key AS sourceRecordKey
      FROM app.article_import_route_source_record
      ORDER BY source_record_key ASC
    `)
    const changeLogRows = await database.queryJson<{
      changeKind: string
      changedFields: unknown
      nextSourceRecordHash: string | null
      previousSourceRecordHash: string | null
      sourceRecordKey: string
    }>(`
      SELECT
        change_kind AS changeKind,
        TO_JSON(changed_fields) AS changedFields,
        next_source_record_hash AS nextSourceRecordHash,
        previous_source_record_hash AS previousSourceRecordHash,
        source_record_key AS sourceRecordKey
      FROM app.data_source_article_change_log
      ORDER BY detected_at ASC, created_at ASC, change_kind ASC
    `)

    expect(sourceRecordRows).toEqual([{sourceRecordHash: 'hash-restored', sourceRecordKey: 'pmid:period-change'}])
    expect(
      changeLogRows.map((row) => {
        return row.changeKind
      }),
    ).toEqual(['source_record_changed', 'source_record_deleted', 'source_record_restored'])
    expect(changeLogRows).toMatchObject([
      {
        nextSourceRecordHash: 'hash-changed',
        previousSourceRecordHash: 'hash-original',
        sourceRecordKey: 'pmid:period-change',
      },
      {nextSourceRecordHash: null, previousSourceRecordHash: 'hash-changed', sourceRecordKey: 'pmid:period-change'},
      {
        nextSourceRecordHash: 'hash-restored',
        previousSourceRecordHash: 'hash-changed',
        sourceRecordKey: 'pmid:period-change',
      },
    ])
  })
})
