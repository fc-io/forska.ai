import {mkdtempSync, rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

import {expect, test} from 'bun:test'

test.each(['json', 'xml'] as const)(
  'structured %s imports persist unidentified articles and reuse source identities on reimport',
  (format) => {
    const runtimeRoot = mkdtempSync(join(tmpdir(), 'forska-structured-canonical-'))
    const migrationsUrl = new URL('../../db/migrateDuckdb.ts', import.meta.url).href
    const databaseUrl = new URL('./appDatabaseService.ts', import.meta.url).href
    const serviceUrl = new URL('./structuredFileImportService.ts', import.meta.url).href
    const body = `
      const {writeFileSync} = await import('node:fs')
      const {migrateDuckdb} = await import(${JSON.stringify(migrationsUrl)})
      const {getAppDatabaseService} = await import(${JSON.stringify(databaseUrl)})
      const {analyzeStructuredFileUpload, buildStructuredFileImportConfig, importStructuredFileFromConfig} =
        await import(${JSON.stringify(serviceUrl)})
      await migrateDuckdb()
      const database = getAppDatabaseService()
      const format = ${JSON.stringify(format)}
      const records = [
        {id: 'source-a', title: 'Structured article A', abstract: 'Canonical abstract A'},
        {id: 'source-b', title: 'Structured article B', abstract: 'Canonical abstract B'},
        {title: 'Structured shared title', abstract: 'Canonical abstract C'},
        {title: 'Structured shared title', abstract: 'Canonical abstract D'},
      ]
      const serialize = (rows) => format === 'json'
        ? JSON.stringify({records: rows})
        : '<root>' + rows.map(row => '<record>' + Object.entries(row)
          .map(([key, value]) => '<' + key + '>' + value + '</' + key + '>').join('') + '</record>').join('') + '</root>'
      const inputRecords = [...records, records[0], records[2]]
      const content = serialize(inputRecords)
      const analysis = await analyzeStructuredFileUpload(new File([content], 'records.' + format))
      const boundary = analysis.candidates.find(candidate => candidate.count === 6)
      const config = buildStructuredFileImportConfig({
        ...analysis.upload,
        boundaryDisplayPath: boundary.displayPath,
        boundaryPointer: boundary.pointer,
      })
      const input = {config, dataSourceTitle: 'Structured fixture', importRoute: 'imported-file:fixture-' + format}
      const first = await database.transaction(tx => importStructuredFileFromConfig({...input, tx}))
      const readRows = () => database.queryJson(\`
        SELECT article.id, article.article_title AS title, article.article_summary AS summary,
          source_record.external_article_id AS externalId, source_record.source_record_key AS sourceKey
        FROM app.article article
        INNER JOIN app.article_import_route_source_record source_record ON source_record.article_id = article.id
        ORDER BY title, summary
      \`)
      const before = await readRows()
      writeFileSync(config.assetPath, serialize(inputRecords.map(row => Object.fromEntries(Object.entries(row).reverse()))))
      const second = await importStructuredFileFromConfig(input)
      const after = await readRows()
      await database.close()
      console.log(JSON.stringify({before, after, firstStats: first.stats, secondStats: second.stats}))
    `

    try {
      const result = globalThis.Bun.spawnSync(['bun', '-e', body], {
        cwd: runtimeRoot,
        env: {
          ...process.env,
          DUCKDB_MEMORY_LIMIT: '512MiB',
          DUCKDB_PATH: join(runtimeRoot, 'fixture.duckdb'),
          DUCKDB_TEMP_DIRECTORY: join(runtimeRoot, 'spill'),
          FORSKA_DESKTOP_MODE: 'false',
          SERVER_DUCKDB_OWNER_URL: '',
          SERVER_ROLE: 'dev-single',
        },
      })

      expect(result.exitCode, result.stderr.toString() || result.stdout.toString()).toBe(0)
      const data = JSON.parse(result.stdout.toString().trim().split('\n').at(-1) ?? '{}') as {
        after: {externalId: string; id: string; sourceKey: string; summary: string; title: string}[]
        before: {externalId: string; id: string; sourceKey: string; summary: string; title: string}[]
        firstStats: {importedCount: number; itemCount: number}
        secondStats: {importedCount: number; itemCount: number}
      }

      expect(data.firstStats).toEqual({importedCount: 4, itemCount: 6})
      expect(data.before).toHaveLength(4)
      expect(data.before).toMatchObject([
        {
          externalId: `imported-file:fixture-${format}:source-a`,
          sourceKey: `imported-file:fixture-${format}:source-a`,
          summary: 'Canonical abstract A',
          title: 'Structured article A',
        },
        {
          externalId: `imported-file:fixture-${format}:source-b`,
          sourceKey: `imported-file:fixture-${format}:source-b`,
          summary: 'Canonical abstract B',
          title: 'Structured article B',
        },
        {summary: 'Canonical abstract C', title: 'Structured shared title'},
        {summary: 'Canonical abstract D', title: 'Structured shared title'},
      ])
      expect(data.before[2]?.sourceKey).toMatch(new RegExp(`^imported-file:fixture-${format}:[0-9a-f]{24}$`))
      expect(data.before[3]?.sourceKey).not.toBe(data.before[2]?.sourceKey)
      expect(data.secondStats).toEqual({importedCount: 4, itemCount: 6})
      expect(data.after).toEqual(data.before)
    } finally {
      rmSync(runtimeRoot, {force: true, recursive: true})
    }
  },
  120_000,
)
