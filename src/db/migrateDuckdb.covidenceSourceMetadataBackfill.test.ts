import {readFileSync} from 'node:fs'
import {resolve} from 'node:path'

import {afterAll, beforeAll, expect, setDefaultTimeout, test} from 'bun:test'

import type {getAppDatabaseService} from '../server/services/appDatabaseService.ts'
import {createTempRuntimeRoot} from '../server/test/createTempRuntimeRoot.ts'

setDefaultTimeout(120_000)

const tempRuntimeRoot = createTempRuntimeRoot('migrate-covidence-source-metadata-backfill')

process.env.SERVER_ROLE = 'dev-single'
process.env.DUCKDB_PATH = tempRuntimeRoot.duckdbPath

const migrationFileName = '0257_covidenceSourceMetadataBackfill.sql'
const previousMigrationFileName = '0256_reviewChangeDeltaUseMetadata.sql'
const migrationSql = readFileSync(resolve(import.meta.dir, 'duckdbMigrations', migrationFileName), 'utf8')

let database: ReturnType<typeof getAppDatabaseService> | null = null
let migrateDuckdb: typeof import('./migrateDuckdb.ts').migrateDuckdb | null = null

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
  citation: Record<string, string | null> | null
  createdAt: string
  id: string
  importMetadata: unknown
  importRouteId: string
  withCurrentLink?: boolean
}) => {
  const rawPayload = input.citation === null ? {other: true} : {covidence: {citation: input.citation}}

  await getDatabase().run(`
    INSERT INTO app.article_import_route_source_record (
      id, article_id, import_route_id, source_record_key, source_record_hash, raw_payload, import_metadata, created_at, updated_at
    ) VALUES (
      '${input.id}', '${input.articleId}', '${input.importRouteId}', 'key-${input.id}', 'hash-${input.id}',
      ${getJsonLiteral(rawPayload)}, ${getJsonLiteral(input.importMetadata)},
      TIMESTAMPTZ '${input.createdAt}', TIMESTAMPTZ '2026-09-02T09:30:00Z'
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

const insertHotField = async (input: {
  articleId: string
  importRouteId: string
  publicationYear: number | null
  sourceRecordId: string
}) => {
  await getDatabase().run(`
    INSERT INTO app.review_import_article_hot_field (import_route_id, article_id, source_record_key, publication_year)
    VALUES ('${input.importRouteId}', '${input.articleId}', 'key-${input.sourceRecordId}', ${input.publicationYear ?? 'NULL'})
  `)
}

const getHotFieldYearRows = async () => {
  return getDatabase().queryJson<{publicationYear: number | null; sourceRecordKey: string}>(`
    SELECT source_record_key AS sourceRecordKey, publication_year AS publicationYear
    FROM app.review_import_article_hot_field
    ORDER BY source_record_key
  `)
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
    hotFieldYears: await getHotFieldYearRows(),
    sourceRecords: await getSourceRecordMetadataRows(),
  }
}

beforeAll(async () => {
  const [migrateModule, {getAppDatabaseService}, {resetDuckdbServiceForTests}, {resetServerRuntimeRoleForTests}] =
    await Promise.all([
      import('./migrateDuckdb.ts'),
      import('../server/services/appDatabaseService.ts'),
      import('../server/utils/duckdbService.ts'),
      import('../server/utils/serverRuntimeRole.ts'),
    ])

  resetDuckdbServiceForTests()
  resetServerRuntimeRoleForTests()
  migrateDuckdb = migrateModule.migrateDuckdb
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

test('the migration fills missing Covidence metadata keys from the raw citation without overwriting present keys', async () => {
  await insertRoute({id: 'route-covidence-csv', route: 'covidence:data-source-csv'})
  await insertRoute({id: 'route-covidence-ris', route: 'covidence:data-source-ris'})
  await insertRoute({id: 'route-pubmed', route: 'pubmed:data-source-pubmed'})

  await insertArticle({id: 'article-csv', sourceMetadata: {journalTitle: 'BMJ Open', volume: '99'}})
  await insertArticle({id: 'article-ris', sourceMetadata: null})
  await insertArticle({id: 'article-pubmed', sourceMetadata: {journalTitle: 'Nature'}})
  await insertArticle({id: 'article-empty', sourceMetadata: {journalTitle: null}})
  await insertArticle({id: 'article-shared', sourceMetadata: {journalTitle: 'Shared'}})
  await insertArticle({id: 'article-array', sourceMetadata: ['not', 'an', 'object']})

  await insertSourceRecord({
    articleId: 'article-csv',
    citation: {
      accession_number: '38500000',
      issue: '3',
      journal: 'BMJ Open',
      pages: 'e081234',
      published_month: 'Mar',
      published_year: '2024',
      title: 'Study A',
      volume: '14',
      year: 'n.d.',
    },
    createdAt: '2026-09-01T08:00:00Z',
    id: 'source-csv',
    importMetadata: {covidence: {mode: 'title_abstract', studyKey: null}, journalTitle: 'BMJ Open'},
    importRouteId: 'route-covidence-csv',
    withCurrentLink: true,
  })
  await insertSourceRecord({
    articleId: 'article-ris',
    citation: {
      ep: '110',
      is: '2',
      publication_year: '2019',
      reference_type: 'JOUR',
      sp: '100',
      title: 'Study B',
      vl: '9',
    },
    createdAt: '2026-09-01T08:00:00Z',
    id: 'source-ris',
    importMetadata: {journalTitle: null, publicationYear: 2018},
    importRouteId: 'route-covidence-ris',
    withCurrentLink: true,
  })
  await insertSourceRecord({
    articleId: 'article-pubmed',
    citation: {published_year: '2020', volume: '5'},
    createdAt: '2026-09-01T08:00:00Z',
    id: 'source-pubmed',
    importMetadata: {journalTitle: 'Nature'},
    importRouteId: 'route-pubmed',
    withCurrentLink: true,
  })
  await insertSourceRecord({
    articleId: 'article-empty',
    citation: {journal: null, published_year: 'unknown', title: 'No metadata'},
    createdAt: '2026-09-01T08:00:00Z',
    id: 'source-empty',
    importMetadata: {covidence: {mode: 'title_abstract'}, journalTitle: null},
    importRouteId: 'route-covidence-csv',
  })
  await insertSourceRecord({
    articleId: 'article-shared',
    citation: {published_year: '2010', volume: '2'},
    createdAt: '2026-09-03T08:00:00Z',
    id: 'source-shared-late',
    importMetadata: {journalTitle: 'Shared'},
    importRouteId: 'route-covidence-ris',
  })
  await insertSourceRecord({
    articleId: 'article-shared',
    citation: {published_year: '2009', volume: '1'},
    createdAt: '2026-09-01T08:00:00Z',
    id: 'source-shared-early',
    importMetadata: {journalTitle: 'Shared'},
    importRouteId: 'route-covidence-csv',
  })
  await insertSourceRecord({
    articleId: 'article-array',
    citation: {published_year: '2001'},
    createdAt: '2026-09-01T08:00:00Z',
    id: 'source-array',
    importMetadata: ['not', 'an', 'object'],
    importRouteId: 'route-covidence-csv',
  })

  await insertHotField({
    articleId: 'article-csv',
    importRouteId: 'route-covidence-csv',
    publicationYear: null,
    sourceRecordId: 'source-csv',
  })
  await insertHotField({
    articleId: 'article-ris',
    importRouteId: 'route-covidence-ris',
    publicationYear: 1999,
    sourceRecordId: 'source-ris',
  })
  await insertHotField({
    articleId: 'article-pubmed',
    importRouteId: 'route-pubmed',
    publicationYear: null,
    sourceRecordId: 'source-pubmed',
  })

  await getMigrateDuckdb()()

  const csvMetadata = {
    accessionNumber: '38500000',
    issue: '3',
    pages: 'e081234',
    publicationMonth: 'Mar',
    publicationYear: 2024,
    volume: '14',
  }

  expect(await getSourceRecordMetadataRows()).toEqual([
    {id: 'source-array', metadata: ['not', 'an', 'object']},
    {
      id: 'source-csv',
      metadata: {covidence: {mode: 'title_abstract', studyKey: null}, journalTitle: 'BMJ Open', ...csvMetadata},
    },
    {id: 'source-empty', metadata: {covidence: {mode: 'title_abstract'}, journalTitle: null}},
    {id: 'source-pubmed', metadata: {journalTitle: 'Nature'}},
    {
      id: 'source-ris',
      metadata: {
        issue: '2',
        journalTitle: null,
        pages: '100-110',
        publicationType: 'JOUR',
        publicationYear: 2018,
        volume: '9',
      },
    },
    {id: 'source-shared-early', metadata: {journalTitle: 'Shared', publicationYear: 2009, volume: '1'}},
    {id: 'source-shared-late', metadata: {journalTitle: 'Shared', publicationYear: 2010, volume: '2'}},
  ])
  expect(await getCurrentLinkMetadataRows()).toEqual([
    {
      id: 'link-source-csv',
      metadata: {covidence: {mode: 'title_abstract', studyKey: null}, journalTitle: 'BMJ Open', ...csvMetadata},
    },
    {id: 'link-source-pubmed', metadata: {journalTitle: 'Nature'}},
    {
      id: 'link-source-ris',
      metadata: {
        issue: '2',
        journalTitle: null,
        pages: '100-110',
        publicationType: 'JOUR',
        publicationYear: 2018,
        volume: '9',
      },
    },
  ])
  expect(await getHotFieldYearRows()).toEqual([
    {publicationYear: 2024, sourceRecordKey: 'key-source-csv'},
    {publicationYear: null, sourceRecordKey: 'key-source-pubmed'},
    {publicationYear: 1999, sourceRecordKey: 'key-source-ris'},
  ])
  expect(await getArticleMetadataRows()).toEqual([
    {id: 'article-array', metadata: ['not', 'an', 'object']},
    {id: 'article-csv', metadata: {...csvMetadata, journalTitle: 'BMJ Open', volume: '99'}},
    {id: 'article-empty', metadata: {journalTitle: null}},
    {id: 'article-pubmed', metadata: {journalTitle: 'Nature'}},
    {
      id: 'article-ris',
      metadata: {issue: '2', pages: '100-110', publicationType: 'JOUR', publicationYear: 2019, volume: '9'},
    },
    {id: 'article-shared', metadata: {journalTitle: 'Shared', publicationYear: 2009, volume: '1'}},
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
      WHERE table_name LIKE 'covidence_source_metadata_backfill%'
    `),
  ).toEqual([{count: 0}])
})

test('re-running the migration changes nothing', async () => {
  const before = await getAllMetadataRows()

  await getDatabase().run(migrationSql)

  expect(await getAllMetadataRows()).toEqual(before)
})
