import {readFileSync} from 'node:fs'
import {resolve} from 'node:path'

import {afterAll, beforeAll, expect, setDefaultTimeout, test} from 'bun:test'

import type {getAppDatabaseService} from '../server/services/appDatabaseService.ts'
import {createTempRuntimeRoot} from '../server/test/createTempRuntimeRoot.ts'

setDefaultTimeout(120_000)

const tempRuntimeRoot = createTempRuntimeRoot('migrate-covidence-source-url-backfill')

process.env.SERVER_ROLE = 'dev-single'
process.env.DUCKDB_PATH = tempRuntimeRoot.duckdbPath

const migrationFileName = '0274_covidenceSourceUrlBackfill.sql'
const previousMigrationFileName = '0273_dropUserConfigFigureDescriptionModel.sql'
const migrationSql = readFileSync(resolve(import.meta.dir, 'duckdbMigrations', migrationFileName), 'utf8')

let database: ReturnType<typeof getAppDatabaseService> | null = null
let migrateDuckdb: typeof import('./migrateDuckdb.ts').migrateDuckdb | null = null
let getCovidenceBibliographicMetadata:
  | typeof import('../server/services/covidenceImportService.ts').getCovidenceBibliographicMetadata
  | null = null

type MetadataRow = {id: string; metadata: Record<string, unknown> | unknown[] | null}

const getDatabase = () => {
  if (database === null) {
    throw new Error('Database not initialized')
  }

  return database
}

const getMigrateDuckdb = () => {
  if (migrateDuckdb === null) {
    throw new Error('Migrations not initialized')
  }

  return migrateDuckdb
}

const getImportSourceUrl = (citation: Record<string, string | null>) => {
  if (getCovidenceBibliographicMetadata === null) {
    throw new Error('Covidence import not initialized')
  }

  return getCovidenceBibliographicMetadata(citation).sourceUrl ?? null
}

const getJsonLiteral = (value: unknown) => {
  return value === null ? 'NULL' : `json('${JSON.stringify(value).replaceAll("'", "''")}')`
}

const insertRoute = async (input: {id: string; route: string}) => {
  await getDatabase().run(`
    INSERT INTO app.import_route (id, route, name, active)
    VALUES ('${input.id}', '${input.route}', '${input.route}', TRUE)
  `)
}

const insertArticle = async (input: {id: string; sourceMetadata: unknown}) => {
  await getDatabase().run(`
    INSERT INTO app.article (id, article_title, source_metadata)
    VALUES ('${input.id}', 'Title ${input.id}', ${getJsonLiteral(input.sourceMetadata)})
  `)
}

const insertSourceRecord = async (input: {
  articleId: string
  citation: Record<string, string | null>
  createdAt: string
  id: string
  importMetadata: unknown
  importRouteId: string
  withCurrentLink?: boolean
}) => {
  const rawPayload = {covidence: {citation: input.citation}}

  await getDatabase().run(`
    INSERT INTO app.article_import_route_source_record (
      id, article_id, import_route_id, source_record_key, source_record_hash, raw_payload, import_metadata, created_at, updated_at
    ) VALUES (
      '${input.id}', '${input.articleId}', '${input.importRouteId}', 'key-${input.id}', 'hash-${input.id}',
      ${getJsonLiteral(rawPayload)}, ${getJsonLiteral(input.importMetadata)},
      TIMESTAMPTZ '${input.createdAt}', TIMESTAMPTZ '2026-10-21T09:30:00Z'
    )
  `)

  if (input.withCurrentLink) {
    await getDatabase().run(`
      INSERT INTO app.article_import_route (
        id, article_id, import_route_id, source_record_key, source_record_hash, raw_payload, import_metadata
      ) VALUES (
        'link-${input.id}', '${input.articleId}', '${input.importRouteId}', 'key-${input.id}', 'hash-${input.id}',
        ${getJsonLiteral(rawPayload)}, ${getJsonLiteral(input.importMetadata)}
      )
    `)
  }
}

const getParsedMetadataRows = (rows: Array<{id: string; metadata: unknown}>): MetadataRow[] => {
  return rows.map((row) => {
    return {
      id: row.id,
      metadata: typeof row.metadata === 'string' ? (JSON.parse(row.metadata) as MetadataRow['metadata']) : null,
    }
  })
}

const getSourceRecordMetadataRows = async () => {
  return getParsedMetadataRows(
    await getDatabase().queryJson<{id: string; metadata: unknown}>(`
      SELECT id, CAST(import_metadata AS VARCHAR) AS metadata
      FROM app.article_import_route_source_record
      ORDER BY id
    `),
  )
}

const getCurrentLinkMetadataRows = async () => {
  return getParsedMetadataRows(
    await getDatabase().queryJson<{id: string; metadata: unknown}>(`
      SELECT id, CAST(import_metadata AS VARCHAR) AS metadata
      FROM app.article_import_route
      ORDER BY id
    `),
  )
}

const getArticleMetadataRows = async () => {
  return getParsedMetadataRows(
    await getDatabase().queryJson<{id: string; metadata: unknown}>(`
      SELECT id, CAST(source_metadata AS VARCHAR) AS metadata
      FROM app.article
      ORDER BY id
    `),
  )
}

const getAllMetadataRows = async () => {
  return {
    articles: await getArticleMetadataRows(),
    currentLinks: await getCurrentLinkMetadataRows(),
    sourceRecords: await getSourceRecordMetadataRows(),
  }
}

const parityCitations: Array<{id: string; citation: Record<string, string | null>}> = [
  {id: 'parity-01', citation: {doi: 'https://clinicaltrials.gov/study/NCT00005915'}},
  {id: 'parity-02', citation: {doi: '  http://www.ctri.nic.in/Clinicaltrials/pmaindet2.php?trialid=3379  '}},
  {id: 'parity-03', citation: {doi: 'HTTP://EN.IRCT.IR/trial/1031'}},
  {id: 'parity-04', citation: {doi: 'https://dx.doi.org/10.1000/alpha'}},
  {id: 'parity-05', citation: {doi: 'HTTPS://WWW.DOI.ORG/10.1000/beta'}},
  {id: 'parity-06', citation: {doi: 'http://doi.org'}},
  {id: 'parity-07', citation: {doi: 'https://doi.organisation.example/record/1'}},
  {id: 'parity-08', citation: {doi: '10.1000/gamma'}},
  {id: 'parity-09', citation: {doi: 'doi:10.1000/delta'}},
  {id: 'parity-10', citation: {doi: 'ftp://registry.example/trial/1'}},
  {id: 'parity-11', citation: {doi: '   '}},
  {
    id: 'parity-12',
    citation: {
      doi: 'https://www.embase.com/search/results?subaction=viewrecord&id=LNCT00144638&from=exporthttps://clinicaltrials.gov/study/NCT00144638',
    },
  },
  {id: 'parity-13', citation: {doi: '10.1000/epsilon', url: 'https://www.isrctn.com/ISRCTN10957189'}},
  {id: 'parity-14', citation: {doi: 'https://dx.doi.org/0161903/AIM.009', url: 'https://doi.org/10.1000/zeta'}},
  {id: 'parity-15', citation: {doi: null, url: 'https://anzctr.org.au/ACTRN12611000750987.aspx'}},
  {
    id: 'parity-16',
    citation: {
      doi: 'https://www.cochranelibrary.com/central/doi/10.1002/central/CN-01800343/full',
      url: 'https://www.isrctn.com/ISRCTN13817256',
    },
  },
]

beforeAll(async () => {
  const [
    migrateModule,
    covidenceImportModule,
    {getAppDatabaseService},
    {resetDuckdbServiceForTests},
    {resetServerRuntimeRoleForTests},
  ] = await Promise.all([
    import('./migrateDuckdb.ts'),
    import('../server/services/covidenceImportService.ts'),
    import('../server/services/appDatabaseService.ts'),
    import('../server/utils/duckdbService.ts'),
    import('../server/utils/serverRuntimeRole.ts'),
  ])

  resetDuckdbServiceForTests()
  resetServerRuntimeRoleForTests()
  migrateDuckdb = migrateModule.migrateDuckdb
  getCovidenceBibliographicMetadata = covidenceImportModule.getCovidenceBibliographicMetadata
  await migrateDuckdb({throughFileName: previousMigrationFileName})

  database = getAppDatabaseService()
})

afterAll(async () => {
  await database?.close()
  tempRuntimeRoot.cleanup()
})

test('the migration has no comments and no semicolons inside string literals', () => {
  const stringLiterals = migrationSql.match(/'(?:[^']|'')*'/g) ?? []

  expect(migrationSql).not.toContain('--')
  expect(stringLiterals.length).toBeGreaterThan(0)
  expect(
    stringLiterals.filter((literal) => {
      return literal.includes(';')
    }),
  ).toEqual([])
})

test('the migration fills a missing sourceUrl from the raw Covidence DOI or URL column without overwriting one', async () => {
  await insertRoute({id: 'route-covidence-csv', route: 'covidence:data-source-csv'})
  await insertRoute({id: 'route-covidence-ris', route: 'covidence:data-source-ris'})
  await insertRoute({id: 'route-pubmed', route: 'pubmed:data-source-pubmed'})

  await insertArticle({id: 'article-nct', sourceMetadata: {accessionNumber: 'NCT00005915', journalTitle: null}})
  await insertArticle({id: 'article-ris', sourceMetadata: null})
  await insertArticle({id: 'article-doi', sourceMetadata: {journalTitle: 'BMJ Open'}})
  await insertArticle({id: 'article-kept', sourceMetadata: {sourceUrl: 'https://kept.example/record'}})
  await insertArticle({id: 'article-pubmed', sourceMetadata: {journalTitle: 'Nature'}})
  await insertArticle({id: 'article-shared', sourceMetadata: {journalTitle: null}})
  await insertArticle({id: 'article-array', sourceMetadata: ['not', 'an', 'object']})

  await insertSourceRecord({
    articleId: 'article-nct',
    citation: {accession_number: 'NCT00005915', doi: 'https://clinicaltrials.gov/study/NCT00005915', title: 'A'},
    createdAt: '2026-10-01T08:00:00Z',
    id: 'source-nct',
    importMetadata: {accessionNumber: 'NCT00005915', covidence: {mode: 'title_abstract'}, journalTitle: null},
    importRouteId: 'route-covidence-csv',
    withCurrentLink: true,
  })
  await insertSourceRecord({
    articleId: 'article-ris',
    citation: {doi: '10.1000/ris', title: 'B', url: 'http://www.chictr.org.cn/showproj.aspx?proj=15716'},
    createdAt: '2026-10-01T08:00:00Z',
    id: 'source-ris',
    importMetadata: null,
    importRouteId: 'route-covidence-ris',
    withCurrentLink: true,
  })
  await insertSourceRecord({
    articleId: 'article-doi',
    citation: {doi: 'https://dx.doi.org/10.1000/Alpha', title: 'C'},
    createdAt: '2026-10-01T08:00:00Z',
    id: 'source-doi',
    importMetadata: {journalTitle: 'BMJ Open'},
    importRouteId: 'route-covidence-csv',
    withCurrentLink: true,
  })
  await insertSourceRecord({
    articleId: 'article-kept',
    citation: {doi: 'https://www.isrctn.com/ISRCTN10957189', title: 'D'},
    createdAt: '2026-10-01T08:00:00Z',
    id: 'source-kept',
    importMetadata: {sourceUrl: 'https://kept.example/record'},
    importRouteId: 'route-covidence-csv',
  })
  await insertSourceRecord({
    articleId: 'article-pubmed',
    citation: {doi: 'https://clinicaltrials.gov/study/NCT00039741', title: 'E'},
    createdAt: '2026-10-01T08:00:00Z',
    id: 'source-pubmed',
    importMetadata: {journalTitle: 'Nature'},
    importRouteId: 'route-pubmed',
    withCurrentLink: true,
  })
  await insertSourceRecord({
    articleId: 'article-shared',
    citation: {doi: 'https://en.irct.ir/trial/2', title: 'F'},
    createdAt: '2026-10-03T08:00:00Z',
    id: 'source-shared-late',
    importMetadata: {journalTitle: null},
    importRouteId: 'route-covidence-ris',
  })
  await insertSourceRecord({
    articleId: 'article-shared',
    citation: {doi: 'https://en.irct.ir/trial/1', title: 'F'},
    createdAt: '2026-10-01T08:00:00Z',
    id: 'source-shared-early',
    importMetadata: {journalTitle: null},
    importRouteId: 'route-covidence-csv',
  })
  await insertSourceRecord({
    articleId: 'article-array',
    citation: {doi: 'https://anzctr.org.au/ACTRN12611000750987.aspx'},
    createdAt: '2026-10-01T08:00:00Z',
    id: 'source-array',
    importMetadata: ['not', 'an', 'object'],
    importRouteId: 'route-covidence-csv',
  })

  await getMigrateDuckdb()()

  const nctMetadata = {
    accessionNumber: 'NCT00005915',
    covidence: {mode: 'title_abstract'},
    journalTitle: null,
    sourceUrl: 'https://clinicaltrials.gov/study/NCT00005915',
  }
  const risMetadata = {sourceUrl: 'http://www.chictr.org.cn/showproj.aspx?proj=15716'}

  expect(await getSourceRecordMetadataRows()).toEqual([
    {id: 'source-array', metadata: ['not', 'an', 'object']},
    {id: 'source-doi', metadata: {journalTitle: 'BMJ Open'}},
    {id: 'source-kept', metadata: {sourceUrl: 'https://kept.example/record'}},
    {id: 'source-nct', metadata: nctMetadata},
    {id: 'source-pubmed', metadata: {journalTitle: 'Nature'}},
    {id: 'source-ris', metadata: risMetadata},
    {id: 'source-shared-early', metadata: {journalTitle: null, sourceUrl: 'https://en.irct.ir/trial/1'}},
    {id: 'source-shared-late', metadata: {journalTitle: null, sourceUrl: 'https://en.irct.ir/trial/2'}},
  ])
  expect(await getCurrentLinkMetadataRows()).toEqual([
    {id: 'link-source-doi', metadata: {journalTitle: 'BMJ Open'}},
    {id: 'link-source-nct', metadata: nctMetadata},
    {id: 'link-source-pubmed', metadata: {journalTitle: 'Nature'}},
    {id: 'link-source-ris', metadata: risMetadata},
  ])
  expect(await getArticleMetadataRows()).toEqual([
    {id: 'article-array', metadata: ['not', 'an', 'object']},
    {id: 'article-doi', metadata: {journalTitle: 'BMJ Open'}},
    {id: 'article-kept', metadata: {sourceUrl: 'https://kept.example/record'}},
    {
      id: 'article-nct',
      metadata: {
        accessionNumber: 'NCT00005915',
        journalTitle: null,
        sourceUrl: 'https://clinicaltrials.gov/study/NCT00005915',
      },
    },
    {id: 'article-pubmed', metadata: {journalTitle: 'Nature'}},
    {id: 'article-ris', metadata: risMetadata},
    {id: 'article-shared', metadata: {journalTitle: null, sourceUrl: 'https://en.irct.ir/trial/1'}},
  ])
  expect(
    await getDatabase().queryJson<{name: string}>(`
      SELECT name
      FROM app_schema_migration
      WHERE name = '${migrationFileName}'
    `),
  ).toEqual([{name: migrationFileName}])
  expect(
    await getDatabase().queryJson<{count: number}>(`
      SELECT COUNT(*)::INTEGER AS count
      FROM duckdb_tables()
      WHERE table_name LIKE 'covidence_source_url_backfill%'
    `),
  ).toEqual([{count: 0}])
})

test('re-running the migration changes nothing', async () => {
  const before = await getAllMetadataRows()

  await getDatabase().run(migrationSql)

  expect(await getAllMetadataRows()).toEqual(before)
})

test('the migration stores the same sourceUrl as a fresh Covidence import of the same citation', async () => {
  await parityCitations.reduce(async (previous, entry) => {
    await previous
    await insertArticle({id: `article-${entry.id}`, sourceMetadata: null})
    await insertSourceRecord({
      articleId: `article-${entry.id}`,
      citation: entry.citation,
      createdAt: '2026-10-01T08:00:00Z',
      id: entry.id,
      importMetadata: null,
      importRouteId: 'route-covidence-csv',
    })
  }, Promise.resolve())

  await getDatabase().run(migrationSql)

  const migratedSourceUrls = (await getSourceRecordMetadataRows())
    .filter((row) => {
      return row.id.startsWith('parity-')
    })
    .map((row) => {
      const metadata = row.metadata && !Array.isArray(row.metadata) ? row.metadata : {}

      return {id: row.id, sourceUrl: metadata.sourceUrl ?? null}
    })
  const importSourceUrls = parityCitations.map((entry) => {
    return {id: entry.id, sourceUrl: getImportSourceUrl(entry.citation)}
  })

  expect(migratedSourceUrls).toEqual(importSourceUrls)
  expect(
    importSourceUrls.filter((entry) => {
      return entry.sourceUrl !== null
    }).length,
  ).toBe(8)
})
