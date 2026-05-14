import {createHash} from 'node:crypto'

import type {PublicationStatus} from '../../db/schemaTypes.ts'
import {getArticleSourceMetadata, getOriginalDoi, normalizeDoi} from '../../utils/articleSourceMetadata.ts'
import {getAppDatabaseService} from './appDatabaseService.ts'
import {getJsonValue, getQuotedStringList, getSqlLiteral} from './appQueryHelpers.ts'
import {
  type CanonicalArticleFieldCandidate,
  type CurrentCanonicalArticleFields,
  getCanonicalArticleSourceTrustRank,
  resolveCanonicalArticleFields,
} from './articleCanonicalFieldResolver.ts'
import {getProjectMartDirtyRefreshStateService} from './projectMartDirtyRefreshStateService.ts'

export type ArticleImportStoreTx = {
  queryJson: <T>(statement: string) => Promise<T[]>
  run: (statement: string) => Promise<void>
}

type ArticleImportStoreRow = {
  articleId: string
  articleTitle: string
  articleSummary: string | null
  articleAuthors: string[] | null
  importRoute: string
  articleUpdatedAt?: Date | null
  articleCreatedAt?: Date | null
  articleVersion?: number | null
  arxivId?: string | null
  biorxivId?: string | null
  medrxivId?: string | null
  doi?: string | null
  pubmedId?: string | null
  url?: string | null
  originalData?: unknown
  sourceMetadata?: unknown
  fullText?: string | null
  fullTextHtml?: string | null
  fullTextPDF?: string | null
  fullTextSource?: string | null
  fullTextOriginalFormat?: string | null
  fullTextFetchedAt?: Date | null
  fullTextConversionStatus?: string | null
  fullTextConversionError?: string | null
  fullTextConversionAttempts?: number | null
  fullTextCharCount?: number | null
  publicationStatus?: PublicationStatus | null
  externalArticleId?: string | null
  sourceKind?: string | null
  importMetadata?: unknown
  matchMetadata?: unknown
  importRunId?: string | null
  sourceRecordKey?: string | null
  sourceRecordHash?: string | null
  rawPayload?: unknown
}
type UpsertedArticleRow = {articleId: string; id: string}
type ScopedArticleImportStoreRow = ArticleImportStoreRow & {
  externalArticleId: string | null
  sourceKind: string | null
  importMetadata: unknown
  matchMetadata: unknown
  importRunId: string | null
  sourceRecordKey: string
  sourceRecordHash: string
  rawPayload: unknown
}
type ArticleImportRouteLinkRecord = {
  articleId: string
  externalArticleId: string | null
  importMetadata: unknown
  importRouteId: string
  importRunId: string | null
  matchMetadata: unknown
  rawPayload: unknown
  sourceKind: string | null
  sourceRecordHash: string
  sourceRecordKey: string
}
type ExistingArticleImportRouteLink = {
  articleId: string
  importRouteId: string
  sourceRecordHash: string | null
  sourceRecordKey: string | null
}
type ExistingArticleImportSourceRecord = {
  articleId: string
  importRouteId: string
  legacyArticleId: string | null
  sourceRecordHash: string
  sourceRecordKey: string
}
type ExistingCanonicalArticleRow = {
  articleAuthors: unknown
  articleCreatedAt: Date | string | null
  articleId: string | null
  articleSummary: string | null
  articleTitle: string
  arxivId: string | null
  biorxivId: string | null
  createdAt: Date | string | null
  doi: string | null
  id: string
  importRoute: string | null
  legacyArticleId: string
  medrxivId: string | null
  publicationStatus: PublicationStatus | null
  pubmedId: string | null
  sourceMetadata: unknown
  url: string | null
}

const articleColumnMap = {
  articleId: 'article_id',
  articleTitle: 'article_title',
  articleSummary: 'article_summary',
  articleAuthors: 'article_authors',
  importRoute: 'import_route',
  articleUpdatedAt: 'article_updated_at',
  articleCreatedAt: 'article_created_at',
  articleVersion: 'article_version',
  arxivId: 'arxiv_id',
  biorxivId: 'biorxiv_id',
  medrxivId: 'medrxiv_id',
  doi: 'doi',
  pubmedId: 'pubmed_id',
  url: 'url',
  originalData: 'original_data',
  sourceMetadata: 'source_metadata',
  fullText: 'full_text',
  fullTextHtml: 'full_text_html',
  fullTextPDF: 'full_text_pdf',
  fullTextSource: 'full_text_source',
  fullTextOriginalFormat: 'full_text_original_format',
  fullTextFetchedAt: 'full_text_fetched_at',
  fullTextConversionStatus: 'full_text_conversion_status',
  fullTextConversionError: 'full_text_conversion_error',
  fullTextConversionAttempts: 'full_text_conversion_attempts',
  fullTextCharCount: 'full_text_char_count',
  publicationStatus: 'publication_status',
} as const

type PersistedArticleKey = keyof typeof articleColumnMap

const requiredArticleKeys = [
  'articleId',
  'articleTitle',
  'articleSummary',
  'articleAuthors',
  'importRoute',
] as const satisfies readonly PersistedArticleKey[]

const optionalArticleKeys = [
  'articleUpdatedAt',
  'articleCreatedAt',
  'articleVersion',
  'arxivId',
  'biorxivId',
  'medrxivId',
  'doi',
  'pubmedId',
  'url',
  'originalData',
  'sourceMetadata',
  'fullText',
  'fullTextHtml',
  'fullTextPDF',
  'fullTextSource',
  'fullTextOriginalFormat',
  'fullTextFetchedAt',
  'fullTextConversionStatus',
  'fullTextConversionError',
  'fullTextConversionAttempts',
  'fullTextCharCount',
  'publicationStatus',
] as const satisfies readonly PersistedArticleKey[]
const articleImportBatchSize = 500

const getValueChunks = <TValue>(values: TValue[], chunkSize = articleImportBatchSize): TValue[][] => {
  return values.length === 0
    ? []
    : values.length <= chunkSize
      ? [values]
      : [values.slice(0, chunkSize), ...getValueChunks(values.slice(chunkSize), chunkSize)]
}

const getUniqueValues = (values: string[]) => {
  return Array.from(new Set(values))
}

const getIncludedArticleKeys = (rows: ArticleImportStoreRow[]) => {
  const includedOptionalKeys = optionalArticleKeys.filter((key) => {
    return rows.some((row) => {
      return row[key] !== undefined
    })
  })

  return [...requiredArticleKeys, ...includedOptionalKeys] as PersistedArticleKey[]
}

const getNormalizedArticleImportRow = (row: ArticleImportStoreRow): ArticleImportStoreRow => {
  const doi = normalizeDoi(row.doi) ?? getOriginalDoi(row.originalData)
  const sourceMetadata =
    row.sourceMetadata
    ?? getArticleSourceMetadata({
      articleId: row.articleId,
      importRoute: row.importRoute,
      originalData: row.originalData,
    })

  return {...row, doi, sourceMetadata}
}

const isObjectRecord = (value: unknown): value is Record<string, unknown> => {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date)
}

const getStableJsonValue = (value: unknown): string => {
  return value instanceof Date
    ? JSON.stringify(value.toISOString())
    : Array.isArray(value)
      ? `[${value
          .map((entry) => {
            return getStableJsonValue(entry)
          })
          .join(',')}]`
      : isObjectRecord(value)
        ? `{${Object.keys(value)
            .sort((left, right) => {
              return left.localeCompare(right)
            })
            .map((key) => {
              return `${JSON.stringify(key)}:${getStableJsonValue(value[key])}`
            })
            .join(',')}}`
        : (JSON.stringify(value) ?? 'null')
}

const getSourceRecordHash = (value: unknown) => {
  return createHash('sha256').update(getStableJsonValue(value)).digest('hex')
}

const getSourceKindFromImportRoute = (importRoute: string) => {
  const routePart = importRoute.split('/').filter(Boolean).at(-1) ?? importRoute
  const sourceKind = routePart.split(':')[0]?.trim() ?? ''

  return sourceKind === '' ? null : sourceKind
}

const getSourceRecordHashPayload = (row: ArticleImportStoreRow, rawPayload: unknown) => {
  return (
    rawPayload ?? {
      articleAuthors: row.articleAuthors,
      articleId: row.articleId,
      articleSummary: row.articleSummary,
      articleTitle: row.articleTitle,
      articleUpdatedAt: row.articleUpdatedAt,
      doi: row.doi,
      publicationStatus: row.publicationStatus,
      pubmedId: row.pubmedId,
      sourceMetadata: row.sourceMetadata,
      url: row.url,
    }
  )
}

const getScopedArticleImportStoreRow = (row: ArticleImportStoreRow): ScopedArticleImportStoreRow => {
  const rawPayload = row.rawPayload ?? row.originalData ?? null
  const externalArticleId = row.externalArticleId ?? row.articleId
  const sourceRecordKey = row.sourceRecordKey ?? externalArticleId
  const sourceRecordHash = row.sourceRecordHash ?? getSourceRecordHash(getSourceRecordHashPayload(row, rawPayload))

  return {
    ...row,
    externalArticleId,
    importMetadata: row.importMetadata ?? row.sourceMetadata ?? null,
    importRunId: row.importRunId ?? null,
    matchMetadata: row.matchMetadata ?? null,
    rawPayload,
    sourceKind: row.sourceKind ?? getSourceKindFromImportRoute(row.importRoute),
    sourceRecordHash,
    sourceRecordKey,
  }
}

const getImportRowSourceRank = (row: ScopedArticleImportStoreRow) => {
  return getCanonicalArticleSourceTrustRank({
    importRoute: row.importRoute,
    sourceKind: row.sourceKind,
    sourceMetadata: row.sourceMetadata,
  })
}

const compareScopedArticleImportRows = (left: ScopedArticleImportStoreRow, right: ScopedArticleImportStoreRow) => {
  const rankDiff = getImportRowSourceRank(left) - getImportRowSourceRank(right)
  const keyDiff = left.sourceRecordKey.localeCompare(right.sourceRecordKey)

  return rankDiff || keyDiff || left.articleId.localeCompare(right.articleId)
}

const getPublicationStatus = (value: unknown): PublicationStatus | null => {
  const normalizedValue = typeof value === 'string' ? value.trim() : ''
  const statuses = ['accepted', 'preprint', 'published', 'retracted', 'submitted'] as const
  const matched = statuses.find((status) => {
    return status === normalizedValue
  })

  return matched ?? null
}

const getStringArrayValue = (value: unknown) => {
  const parsed = getJsonValue(value)
  const arrayValue = Array.isArray(parsed) ? parsed : []

  return arrayValue
    .map((entry) => {
      return typeof entry === 'string' ? entry.trim() : ''
    })
    .filter((entry) => {
      return entry !== ''
    })
}

const getCanonicalArticleFieldCandidate = (row: ScopedArticleImportStoreRow): CanonicalArticleFieldCandidate => {
  return {
    articleAuthors: row.articleAuthors,
    articleCreatedAt: row.articleCreatedAt,
    articleSummary: row.articleSummary,
    articleTitle: row.articleTitle,
    arxivId: row.arxivId,
    biorxivId: row.biorxivId,
    doi: row.doi,
    importRoute: row.importRoute,
    medrxivId: row.medrxivId,
    publicationStatus: row.publicationStatus,
    pubmedId: row.pubmedId,
    sourceKind: row.sourceKind,
    sourceMetadata: row.sourceMetadata,
    sourceRecordKey: row.sourceRecordKey,
    url: row.url,
  }
}

const getCurrentCanonicalArticleFields = (row: ExistingCanonicalArticleRow): CurrentCanonicalArticleFields => {
  return {
    articleAuthors: getStringArrayValue(row.articleAuthors),
    articleCreatedAt: row.articleCreatedAt,
    articleSummary: row.articleSummary,
    articleTitle: row.articleTitle,
    arxivId: row.arxivId,
    biorxivId: row.biorxivId,
    createdAt: row.createdAt,
    doi: row.doi,
    id: row.id,
    importRoute: row.importRoute,
    medrxivId: row.medrxivId,
    publicationStatus: getPublicationStatus(row.publicationStatus),
    pubmedId: row.pubmedId,
    sourceKind: row.importRoute ? getSourceKindFromImportRoute(row.importRoute) : null,
    sourceMetadata: getJsonValue(row.sourceMetadata),
    sourceRecordKey: row.legacyArticleId,
    url: row.url,
  }
}

const getArticleGroups = (rows: ScopedArticleImportStoreRow[]) => {
  return rows.reduce<Map<string, ScopedArticleImportStoreRow[]>>((acc, row) => {
    const existingRows = acc.get(row.articleId) ?? []
    acc.set(row.articleId, [...existingRows, row])
    return acc
  }, new Map())
}

const getResolvedArticleImportStoreRow = (rows: ScopedArticleImportStoreRow[]) => {
  const sortedRows = [...rows].sort(compareScopedArticleImportRows)
  const base = sortedRows[0]
  const resolved = resolveCanonicalArticleFields({
    candidates: sortedRows.map(getCanonicalArticleFieldCandidate),
    current: null,
  })

  return base
    ? {
        ...base,
        articleAuthors: resolved.articleAuthors,
        articleSummary: resolved.articleSummary,
        articleTitle: resolved.articleTitle,
        arxivId: resolved.arxivId,
        biorxivId: resolved.biorxivId,
        doi: resolved.doi,
        medrxivId: resolved.medrxivId,
        publicationStatus: resolved.publicationStatus,
        pubmedId: resolved.pubmedId,
        sourceMetadata: resolved.sourceMetadata,
        url: resolved.url,
      }
    : null
}

const getResolvedArticleImportStoreRows = (articleGroups: Map<string, ScopedArticleImportStoreRow[]>) => {
  return Array.from(articleGroups.values())
    .map(getResolvedArticleImportStoreRow)
    .filter((row): row is ScopedArticleImportStoreRow => {
      return row !== null
    })
}

const getArticleValues = (params: {
  includedKeys: PersistedArticleKey[]
  includeInternalId: boolean
  rows: ArticleImportStoreRow[]
}) => {
  return params.rows
    .map((row) => {
      const values = [
        ...(params.includeInternalId ? [crypto.randomUUID()] : []),
        ...params.includedKeys.map((key) => {
          return row[key] ?? null
        }),
      ]

      return `(${values
        .map((value) => {
          return getSqlLiteral(value)
        })
        .join(', ')})`
    })
    .join(', ')
}

const getArticleSourceColumnNames = (params: {includedKeys: PersistedArticleKey[]; includeInternalId: boolean}) => {
  return [
    ...(params.includeInternalId ? ['id'] : []),
    ...params.includedKeys.map((key) => {
      return articleColumnMap[key]
    }),
  ]
}

const getImportRouteIds = async (tx: ArticleImportStoreTx, routes: string[]) => {
  if (routes.length === 0) {
    return new Map<string, string>()
  }

  const routeRows = await tx.queryJson<{id: string; route: string}>(`
    SELECT id, route
    FROM app.import_route
    WHERE route IN (${getQuotedStringList(routes).join(', ')})
  `)

  return new Map(
    routeRows.map((row) => {
      return [row.route, row.id]
    }),
  )
}

const ensureImportRoutes = async (tx: ArticleImportStoreTx, routes: string[]) => {
  if (routes.length === 0) {
    return new Map<string, string>()
  }

  const existingRoutes = await getImportRouteIds(tx, routes)
  const missingRoutes = routes.filter((route) => {
    return !existingRoutes.has(route)
  })

  if (missingRoutes.length > 0) {
    await tx.run(`
      INSERT INTO app.import_route (id, route, name, active)
      VALUES ${missingRoutes
        .map((route) => {
          return `(${getQuotedStringList([crypto.randomUUID(), route, route]).join(', ')}, TRUE)`
        })
        .join(', ')}
      ON CONFLICT(route) DO NOTHING
    `)
  }

  return getImportRouteIds(tx, routes)
}

const getExistingArticleIds = async (tx: ArticleImportStoreTx, articleIds: string[]) => {
  const uniqueArticleIds = getUniqueValues(articleIds)

  if (uniqueArticleIds.length === 0) {
    return new Set<string>()
  }

  const rows = await getValueChunks(uniqueArticleIds).reduce<Promise<Array<{articleId: string}>>>(
    async (rowsPromise, articleIdChunk) => {
      const existingRows = await rowsPromise
      const chunkRows = await tx.queryJson<{articleId: string}>(`
        SELECT legacy_article_id AS articleId
        FROM app.article_legacy_id_lookup
        WHERE legacy_article_id IN (${getQuotedStringList(articleIdChunk).join(', ')})
      `)

      return [...existingRows, ...chunkRows]
    },
    Promise.resolve([]),
  )

  return new Set(
    rows.map((row) => {
      return row.articleId
    }),
  )
}

const getExistingCanonicalArticles = async (tx: ArticleImportStoreTx, articleIds: string[]) => {
  const uniqueArticleIds = getUniqueValues(articleIds)

  if (uniqueArticleIds.length === 0) {
    return new Map<string, ExistingCanonicalArticleRow>()
  }

  const rows = await getValueChunks(uniqueArticleIds).reduce<Promise<ExistingCanonicalArticleRow[]>>(
    async (rowsPromise, articleIdChunk) => {
      const existingRows = await rowsPromise
      const chunkRows = await tx.queryJson<ExistingCanonicalArticleRow>(`
        SELECT
          article.id AS id,
          article.article_id AS articleId,
          legacy.legacy_article_id AS legacyArticleId,
          article.article_title AS articleTitle,
          article.article_summary AS articleSummary,
          TO_JSON(article.article_authors) AS articleAuthors,
          article.article_created_at AS articleCreatedAt,
          article.arxiv_id AS arxivId,
          article.biorxiv_id AS biorxivId,
          article.medrxiv_id AS medrxivId,
          article.doi AS doi,
          article.pubmed_id AS pubmedId,
          article.url AS url,
          article.import_route AS importRoute,
          article.publication_status AS publicationStatus,
          article.created_at AS createdAt,
          TO_JSON(article.source_metadata) AS sourceMetadata
        FROM app.article_legacy_id_lookup legacy
        INNER JOIN app.article article ON article.id = legacy.article_id
        WHERE legacy.legacy_article_id IN (${getQuotedStringList(articleIdChunk).join(', ')})
        ORDER BY legacy.legacy_article_id ASC, article.created_at ASC, article.id ASC
      `)

      return [...existingRows, ...chunkRows]
    },
    Promise.resolve([]),
  )

  return rows.reduce<Map<string, ExistingCanonicalArticleRow>>((acc, row) => {
    return acc.has(row.legacyArticleId) ? acc : acc.set(row.legacyArticleId, row)
  }, new Map())
}

const insertImportedArticlesInTx = async (params: {
  includedKeys: PersistedArticleKey[]
  rows: ArticleImportStoreRow[]
  tx: ArticleImportStoreTx
}) => {
  if (params.rows.length === 0) {
    return
  }

  const columnNames = getArticleSourceColumnNames({includedKeys: params.includedKeys, includeInternalId: true})

  await getValueChunks(params.rows).reduce<Promise<void>>((previousRun, rowChunk) => {
    return previousRun.then(() => {
      return params.tx.run(`
        INSERT INTO app.article (${columnNames.join(', ')})
        VALUES ${getArticleValues({includedKeys: params.includedKeys, includeInternalId: true, rows: rowChunk})}
      `)
    })
  }, Promise.resolve())
}

const canonicalArticleUpdateColumnMap = {
  articleAuthors: 'article_authors',
  articleSummary: 'article_summary',
  articleTitle: 'article_title',
  arxivId: 'arxiv_id',
  biorxivId: 'biorxiv_id',
  doi: 'doi',
  medrxivId: 'medrxiv_id',
  publicationStatus: 'publication_status',
  pubmedId: 'pubmed_id',
  sourceMetadata: 'source_metadata',
  url: 'url',
} as const

type CanonicalArticleUpdateKey = keyof typeof canonicalArticleUpdateColumnMap
type CanonicalArticleUpdateValues = Record<CanonicalArticleUpdateKey, unknown>

const getExistingCanonicalArticleUpdateValues = (row: ExistingCanonicalArticleRow): CanonicalArticleUpdateValues => {
  return {
    articleAuthors: getStringArrayValue(row.articleAuthors),
    articleSummary: row.articleSummary,
    articleTitle: row.articleTitle,
    arxivId: row.arxivId,
    biorxivId: row.biorxivId,
    doi: row.doi,
    medrxivId: row.medrxivId,
    publicationStatus: getPublicationStatus(row.publicationStatus),
    pubmedId: row.pubmedId,
    sourceMetadata: getJsonValue(row.sourceMetadata),
    url: row.url,
  }
}

const getResolvedCanonicalArticleUpdateValues = (
  current: ExistingCanonicalArticleRow,
  rows: ScopedArticleImportStoreRow[],
): CanonicalArticleUpdateValues => {
  const sortedRows = [...rows].sort(compareScopedArticleImportRows)
  const resolved = resolveCanonicalArticleFields({
    candidates: sortedRows.map(getCanonicalArticleFieldCandidate),
    current: getCurrentCanonicalArticleFields(current),
  })

  return {
    articleAuthors: resolved.articleAuthors,
    articleSummary: resolved.articleSummary,
    articleTitle: resolved.articleTitle,
    arxivId: resolved.arxivId,
    biorxivId: resolved.biorxivId,
    doi: resolved.doi,
    medrxivId: resolved.medrxivId,
    publicationStatus: resolved.publicationStatus,
    pubmedId: resolved.pubmedId,
    sourceMetadata: resolved.sourceMetadata,
    url: resolved.url,
  }
}

const hasCanonicalArticleValueChanged = (left: unknown, right: unknown) => {
  return getStableJsonValue(left) !== getStableJsonValue(right)
}

const getChangedCanonicalArticleUpdateValues = (params: {
  current: ExistingCanonicalArticleRow
  rows: ScopedArticleImportStoreRow[]
}) => {
  const existingValues = getExistingCanonicalArticleUpdateValues(params.current)
  const resolvedValues = getResolvedCanonicalArticleUpdateValues(params.current, params.rows)
  const changedEntries = Object.entries(resolvedValues).filter(
    (entry): entry is [CanonicalArticleUpdateKey, unknown] => {
      return hasCanonicalArticleValueChanged(existingValues[entry[0] as CanonicalArticleUpdateKey], entry[1])
    },
  )

  return Object.fromEntries(changedEntries) as Partial<CanonicalArticleUpdateValues>
}

const updateExistingCanonicalArticlesInTx = async (params: {
  articleGroups: Map<string, ScopedArticleImportStoreRow[]>
  existingArticles: Map<string, ExistingCanonicalArticleRow>
  tx: ArticleImportStoreTx
}) => {
  const updates = Array.from(params.articleGroups.entries())
    .map((entry) => {
      const current = params.existingArticles.get(entry[0])
      const values = current ? getChangedCanonicalArticleUpdateValues({current, rows: entry[1]}) : null

      return current && values && Object.keys(values).length > 0 ? {current, values} : null
    })
    .filter((entry): entry is {current: ExistingCanonicalArticleRow; values: Partial<CanonicalArticleUpdateValues>} => {
      return entry !== null
    })

  await updates.reduce<Promise<void>>((previousRun, update) => {
    return previousRun.then(() => {
      const assignments = Object.entries(update.values).map((entry) => {
        return `${canonicalArticleUpdateColumnMap[entry[0] as CanonicalArticleUpdateKey]} = ${getSqlLiteral(entry[1])}`
      })

      return params.tx.run(`
        UPDATE app.article
        SET
          ${assignments.join(',\n          ')},
          updated_at = now()
        WHERE id = ${getSqlLiteral(update.current.id)}
      `)
    })
  }, Promise.resolve())
}

const getUpsertedArticles = async (tx: ArticleImportStoreTx, articleIds: string[]) => {
  return await getValueChunks(getUniqueValues(articleIds)).reduce<Promise<UpsertedArticleRow[]>>(
    async (rowsPromise, articleIdChunk) => {
      const rows = await rowsPromise
      const chunkRows = await tx.queryJson<UpsertedArticleRow>(`
        SELECT article_id AS id, legacy_article_id AS articleId
        FROM app.article_legacy_id_lookup
        WHERE legacy_article_id IN (${getQuotedStringList(articleIdChunk).join(', ')})
        ORDER BY legacy_article_id ASC, created_at ASC, article_id ASC
      `)

      return [...rows, ...chunkRows]
    },
    Promise.resolve([]),
  )
}

const getArticleImportRouteSourceRecordKey = (record: {importRouteId: string; sourceRecordKey: string}) => {
  return `${record.importRouteId}\u0000${record.sourceRecordKey}`
}

const getArticleImportRouteCurrentLinkKey = (record: {articleId: string; importRouteId: string}) => {
  return `${record.articleId}\u0000${record.importRouteId}`
}

const currentArticleImportRouteColumns = [
  'id',
  'article_id',
  'import_route_id',
  'external_article_id',
  'source_kind',
  'import_metadata',
  'match_metadata',
  'import_run_id',
  'source_record_key',
  'source_record_hash',
  'raw_payload',
] as const

const articleImportRouteSourceRecordColumns = [
  'id',
  'article_id',
  'import_route_id',
  'external_article_id',
  'source_kind',
  'import_metadata',
  'match_metadata',
  'import_run_id',
  'source_record_key',
  'source_record_hash',
  'raw_payload',
] as const

const getArticleImportRouteLinkValue = (record: ArticleImportRouteLinkRecord) => {
  return `(${[
    crypto.randomUUID(),
    record.articleId,
    record.importRouteId,
    record.externalArticleId,
    record.sourceKind,
    record.importMetadata,
    record.matchMetadata,
    record.importRunId,
    record.sourceRecordKey,
    record.sourceRecordHash,
    record.rawPayload,
  ]
    .map((value) => {
      return getSqlLiteral(value)
    })
    .join(', ')})`
}

const getExistingArticleImportRouteSourceRecords = async (
  tx: ArticleImportStoreTx,
  records: ArticleImportRouteLinkRecord[],
) => {
  const routeIds = getUniqueValues(
    records.map((record) => {
      return record.importRouteId
    }),
  )
  const sourceRecordKeys = getUniqueValues(
    records.map((record) => {
      return record.sourceRecordKey
    }),
  )

  if (routeIds.length === 0 || sourceRecordKeys.length === 0) {
    return new Map<string, ExistingArticleImportSourceRecord>()
  }

  const rows = await getValueChunks(sourceRecordKeys).reduce<Promise<ExistingArticleImportSourceRecord[]>>(
    async (rowsPromise, sourceRecordKeyChunk) => {
      const existingRows = await rowsPromise
      const chunkRows = await tx.queryJson<ExistingArticleImportSourceRecord>(`
        SELECT
          source_record.article_id AS articleId,
          source_record.import_route_id AS importRouteId,
          article.article_id AS legacyArticleId,
          source_record.source_record_hash AS sourceRecordHash,
          source_record.source_record_key AS sourceRecordKey
        FROM app.article_import_route_source_record source_record
        INNER JOIN app.article article ON article.id = source_record.article_id
        WHERE source_record.import_route_id IN (${getQuotedStringList(routeIds).join(', ')})
          AND source_record.source_record_key IN (${getQuotedStringList(sourceRecordKeyChunk).join(', ')})
      `)

      return [...existingRows, ...chunkRows]
    },
    Promise.resolve([]),
  )

  return new Map(
    rows.map((row) => {
      return [getArticleImportRouteSourceRecordKey(row), row]
    }),
  )
}

const getExistingArticleImportRouteLinks = async (
  tx: ArticleImportStoreTx,
  records: ArticleImportRouteLinkRecord[],
) => {
  const articleIds = getUniqueValues(
    records.map((record) => {
      return record.articleId
    }),
  )
  const routeIds = getUniqueValues(
    records.map((record) => {
      return record.importRouteId
    }),
  )

  if (articleIds.length === 0 || routeIds.length === 0) {
    return new Map<string, ExistingArticleImportRouteLink>()
  }

  const rows = await getValueChunks(articleIds).reduce<Promise<ExistingArticleImportRouteLink[]>>(
    async (rowsPromise, articleIdChunk) => {
      const existingRows = await rowsPromise
      const chunkRows = await tx.queryJson<ExistingArticleImportRouteLink>(`
        SELECT
          article_id AS articleId,
          import_route_id AS importRouteId,
          source_record_hash AS sourceRecordHash,
          source_record_key AS sourceRecordKey
        FROM app.article_import_route
        WHERE article_id IN (${getQuotedStringList(articleIdChunk).join(', ')})
          AND import_route_id IN (${getQuotedStringList(routeIds).join(', ')})
      `)

      return [...existingRows, ...chunkRows]
    },
    Promise.resolve([]),
  )

  return new Map(
    rows.map((row) => {
      return [getArticleImportRouteCurrentLinkKey(row), row]
    }),
  )
}

const getDeduplicatedSourceRecords = (records: ArticleImportRouteLinkRecord[]) => {
  return Array.from(
    records
      .reduce<Map<string, ArticleImportRouteLinkRecord>>((acc, record) => {
        acc.set(getArticleImportRouteSourceRecordKey(record), record)
        return acc
      }, new Map())
      .values(),
  )
}

const getDeduplicatedCurrentLinks = (records: ArticleImportRouteLinkRecord[]) => {
  return Array.from(
    records
      .reduce<Map<string, ArticleImportRouteLinkRecord>>((acc, record) => {
        acc.set(getArticleImportRouteCurrentLinkKey(record), record)
        return acc
      }, new Map())
      .values(),
  )
}

const upsertArticleImportRouteCurrentLinks = async (
  tx: ArticleImportStoreTx,
  records: ArticleImportRouteLinkRecord[],
) => {
  const deduplicatedRecords = getDeduplicatedCurrentLinks(records)
  const existingLinks = await getExistingArticleImportRouteLinks(tx, deduplicatedRecords)
  const recordsToWrite = deduplicatedRecords.filter((record) => {
    const existingLink = existingLinks.get(getArticleImportRouteCurrentLinkKey(record))

    return (
      !existingLink
      || existingLink.sourceRecordKey !== record.sourceRecordKey
      || existingLink.sourceRecordHash !== record.sourceRecordHash
    )
  })

  await getValueChunks(recordsToWrite).reduce<Promise<void>>((previousRun, recordChunk) => {
    return previousRun.then(() => {
      return recordChunk.length === 0
        ? Promise.resolve()
        : tx.run(`
          INSERT INTO app.article_import_route (${currentArticleImportRouteColumns.join(', ')})
          VALUES ${recordChunk.map(getArticleImportRouteLinkValue).join(', ')}
          ON CONFLICT(article_id, import_route_id) DO UPDATE SET
            external_article_id = excluded.external_article_id,
            source_kind = excluded.source_kind,
            import_metadata = excluded.import_metadata,
            match_metadata = excluded.match_metadata,
            import_run_id = excluded.import_run_id,
            source_record_key = excluded.source_record_key,
            source_record_hash = excluded.source_record_hash,
            raw_payload = excluded.raw_payload,
            updated_at = now()
        `)
    })
  }, Promise.resolve())
}

const upsertArticleImportRouteSourceRecords = async (
  tx: ArticleImportStoreTx,
  records: ArticleImportRouteLinkRecord[],
  existingSourceRecords: Map<string, ExistingArticleImportSourceRecord>,
) => {
  const deduplicatedRecords = getDeduplicatedSourceRecords(records)
  const recordsToWrite = deduplicatedRecords.filter((record) => {
    const existingRecord = existingSourceRecords.get(getArticleImportRouteSourceRecordKey(record))

    return !existingRecord || existingRecord.sourceRecordHash !== record.sourceRecordHash
  })

  await getValueChunks(recordsToWrite).reduce<Promise<void>>((previousRun, recordChunk) => {
    return previousRun.then(() => {
      return recordChunk.length === 0
        ? Promise.resolve()
        : tx.run(`
          INSERT INTO app.article_import_route_source_record (${articleImportRouteSourceRecordColumns.join(', ')})
          VALUES ${recordChunk.map(getArticleImportRouteLinkValue).join(', ')}
          ON CONFLICT(import_route_id, source_record_key) DO UPDATE SET
            article_id = excluded.article_id,
            external_article_id = excluded.external_article_id,
            source_kind = excluded.source_kind,
            import_metadata = excluded.import_metadata,
            match_metadata = excluded.match_metadata,
            import_run_id = excluded.import_run_id,
            source_record_hash = excluded.source_record_hash,
            raw_payload = excluded.raw_payload,
            quarantined_at = NULL,
            quarantine_reason = NULL,
            quarantine_metadata = NULL,
            updated_at = now()
        `)
    })
  }, Promise.resolve())
}

const quarantineRemappedArticleImportSourceRecords = async (
  tx: ArticleImportStoreTx,
  records: ArticleImportRouteLinkRecord[],
) => {
  await records.reduce<Promise<void>>((previousRun, record) => {
    return previousRun.then(() => {
      return tx.run(`
        UPDATE app.article_import_route_source_record
        SET
          quarantined_at = now(),
          quarantine_reason = 'source_record_remap',
          quarantine_metadata = ${getSqlLiteral({
            incomingArticleId: record.articleId,
            incomingExternalArticleId: record.externalArticleId,
            incomingImportRunId: record.importRunId,
            incomingSourceRecordHash: record.sourceRecordHash,
          })},
          updated_at = now()
        WHERE import_route_id = ${getSqlLiteral(record.importRouteId)}
          AND source_record_key = ${getSqlLiteral(record.sourceRecordKey)}
      `)
    })
  }, Promise.resolve())
}

const insertArticleImportRouteLinks = async (tx: ArticleImportStoreTx, records: ArticleImportRouteLinkRecord[]) => {
  const existingSourceRecords = await getExistingArticleImportRouteSourceRecords(tx, records)
  const remappedRecords = records.filter((record) => {
    const existingRecord = existingSourceRecords.get(getArticleImportRouteSourceRecordKey(record))

    return Boolean(existingRecord && existingRecord.articleId !== record.articleId)
  })
  const acceptedRecords = records.filter((record) => {
    const existingRecord = existingSourceRecords.get(getArticleImportRouteSourceRecordKey(record))

    return !existingRecord || existingRecord.articleId === record.articleId
  })

  await quarantineRemappedArticleImportSourceRecords(tx, remappedRecords)
  await upsertArticleImportRouteSourceRecords(tx, acceptedRecords, existingSourceRecords)
  await upsertArticleImportRouteCurrentLinks(tx, acceptedRecords)
}

const storeImportedArticlesInTx = async (tx: ArticleImportStoreTx, rows: ArticleImportStoreRow[]) => {
  if (rows.length === 0) {
    return {importRouteIds: [] as string[]}
  }

  const normalizedRows = rows.map((row) => {
    return getScopedArticleImportStoreRow(getNormalizedArticleImportRow(row))
  })
  const articleGroups = getArticleGroups(normalizedRows)
  const articleRows = getResolvedArticleImportStoreRows(articleGroups)
  const includedKeys = getIncludedArticleKeys(articleRows)
  const routes = Array.from(
    new Set(
      normalizedRows
        .map((row) => {
          return row.importRoute
        })
        .filter((route) => {
          return route.trim() !== ''
        }),
    ),
  )
  const routeIdMap = await ensureImportRoutes(tx, routes)
  const existingArticleIds = await getExistingArticleIds(
    tx,
    articleRows.map((row) => {
      return row.articleId
    }),
  )
  const existingCanonicalArticles = await getExistingCanonicalArticles(
    tx,
    articleRows.map((row) => {
      return row.articleId
    }),
  )
  const rowsToInsert = articleRows.filter((row) => {
    return !existingArticleIds.has(row.articleId)
  })

  await insertImportedArticlesInTx({includedKeys, rows: rowsToInsert, tx})
  await updateExistingCanonicalArticlesInTx({articleGroups, existingArticles: existingCanonicalArticles, tx})

  const upsertedArticles = await getUpsertedArticles(
    tx,
    articleRows.map((row) => {
      return row.articleId
    }),
  )

  const articleIdToArticle = new Map(
    upsertedArticles.map((article) => {
      return [article.articleId, article.id]
    }),
  )
  const linkRecords = normalizedRows
    .map((article) => {
      const articleId = articleIdToArticle.get(article.articleId)
      const importRouteId = routeIdMap.get(article.importRoute)

      return articleId && importRouteId
        ? {
            articleId,
            externalArticleId: article.externalArticleId,
            importMetadata: article.importMetadata,
            importRouteId,
            importRunId: article.importRunId,
            matchMetadata: article.matchMetadata,
            rawPayload: article.rawPayload,
            sourceKind: article.sourceKind,
            sourceRecordHash: article.sourceRecordHash,
            sourceRecordKey: article.sourceRecordKey,
          }
        : null
    })
    .filter((value): value is ArticleImportRouteLinkRecord => {
      return value !== null
    })

  if (linkRecords.length > 0) {
    await insertArticleImportRouteLinks(tx, linkRecords)
  }

  return {importRouteIds: Array.from(routeIdMap.values())}
}

const clearImportRouteLinks = async (tx: ArticleImportStoreTx, importRouteId: string) => {
  await tx.run(`
    DELETE FROM app.article_import_route
    WHERE import_route_id = ${getSqlLiteral(importRouteId)}
  `)
}

const syncImportedArticlesInTx = async (params: {
  importRoute: string
  rows: ArticleImportStoreRow[]
  tx: ArticleImportStoreTx
}) => {
  const importRoute = params.importRoute.trim()
  const routes = importRoute === '' ? [] : [importRoute]
  const routeIdMap = await ensureImportRoutes(params.tx, routes)
  const importRouteId = routeIdMap.get(importRoute)

  if (importRouteId) {
    await clearImportRouteLinks(params.tx, importRouteId)
  }

  const importRefreshState =
    params.rows.length > 0 ? await storeImportedArticlesInTx(params.tx, params.rows) : {importRouteIds: [] as string[]}

  return {
    importRouteIds:
      importRouteId && !importRefreshState.importRouteIds.includes(importRouteId)
        ? [...importRefreshState.importRouteIds, importRouteId]
        : importRefreshState.importRouteIds,
  }
}

export const markImportedArticleProjectsDirty = async (importRouteIds: string[]) => {
  if (importRouteIds.length === 0) {
    return
  }

  await getAppDatabaseService().transaction(async (tx) => {
    const projectRows = await tx.queryJson<{projectId: string}>(`
      SELECT DISTINCT project_import_route.project_id AS projectId
      FROM app.project_import_route project_import_route
      INNER JOIN app.project project ON project.id = project_import_route.project_id
      WHERE project_import_route.import_route_id IN (${getQuotedStringList(importRouteIds).join(', ')})
        AND project.archived = FALSE
      ORDER BY projectId ASC
    `)
    const projectIds = projectRows.map((row) => {
      return row.projectId
    })
    const refreshStateService = getProjectMartDirtyRefreshStateService()
    const dirtyProjects = await refreshStateService.getDirtyProjectsForProjectIds(tx, projectIds)

    await refreshStateService.markProjectsDirtyAtomically({
      projects: dirtyProjects,
      reason: 'articleImportStoreService',
      runner: tx,
    })
  })
}

export const storeImportedArticlesWithTx = async (tx: ArticleImportStoreTx, rows: ArticleImportStoreRow[]) => {
  return await storeImportedArticlesInTx(tx, rows)
}

export const syncImportedArticlesWithTx = async (params: {
  importRoute: string
  rows: ArticleImportStoreRow[]
  tx: ArticleImportStoreTx
}) => {
  return await syncImportedArticlesInTx(params)
}

export const storeImportedArticles = async (rows: ArticleImportStoreRow[]) => {
  const importRefreshState = (await getAppDatabaseService().transaction(async (tx) => {
    return await storeImportedArticlesInTx(tx, rows)
  })) as {importRouteIds: string[]}

  await markImportedArticleProjectsDirty(importRefreshState.importRouteIds)
}

export type {ArticleImportStoreRow}
