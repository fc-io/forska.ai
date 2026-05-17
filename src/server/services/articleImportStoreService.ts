import {createHash} from 'node:crypto'

import type {PublicationStatus} from '../../db/schemaTypes.ts'
import {
  type ArticleIdentifierConflict,
  type ArticleIdentifierInput,
  type ArticleStrongIdentifierKind,
  type NormalizedSourceRowIdentifiers,
  normalizeSourceRowIdentifiers,
  type RejectedArticleIdentifierNormalization,
} from '../../utils/articleIdentifierNormalization.ts'
import {getArticleSourceMetadata, getOriginalDoi, normalizeDoi} from '../../utils/articleSourceMetadata.ts'
import {getAppDatabaseService} from './appDatabaseService.ts'
import {getJsonValue, getQuotedStringList, getSqlLiteral} from './appQueryHelpers.ts'
import {
  type CanonicalArticleFieldCandidate,
  type CurrentCanonicalArticleFields,
  getCanonicalArticleSourceTrustRank,
  resolveCanonicalArticleFields,
} from './articleCanonicalFieldResolver.ts'
import {
  type CanonicalArticleMatchCandidate,
  type CanonicalArticleMatchIdentifier,
  type CanonicalArticleMatchOutcome,
  matchCanonicalArticlesWithTx,
} from './articleCanonicalMatcher.ts'
import {getProjectMartDirtyRefreshStateService} from './projectMartDirtyRefreshStateService.ts'

export type ArticleImportStoreTx = {
  queryJson: <T>(statement: string) => Promise<T[]>
  run: (statement: string) => Promise<void>
}

export type ArticleImportStoreRow = {
  allowUnidentifiedCreate?: boolean
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
type CanonicalArticleImportCandidateRecord = {
  candidate: CanonicalArticleMatchCandidate
  identifierNormalization: NormalizedSourceRowIdentifiers
  row: ScopedArticleImportStoreRow
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
type ArticleImportRouteRemapRecord = {
  externalArticleId: string | null
  importRouteId: string
  importRunId: string | null
  incomingArticleId: string | null
  sourceRecordHash: string
  sourceRecordKey: string
}
type ArticleImportRouteSourceRecordLookup = {importRouteId: string; sourceRecordKey: string}
type ArticleImportRouteSourceRecordCandidate = {
  candidateRecord: CanonicalArticleImportCandidateRecord
  importRouteId: string
}
type ArticleIdentifierQuarantineRecord = {
  candidateId: string
  importRunId: string | null
  kind: ArticleStrongIdentifierKind
  metadata: unknown
  normalizedValue: string
  reason: string
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
type ExistingCanonicalArticleIdentifierRow = {
  articleId: string
  kind: ArticleStrongIdentifierKind
  normalizedValue: string
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
  legacyArticleId: string | null
  medrxivId: string | null
  publicationStatus: PublicationStatus | null
  pubmedId: string | null
  sourceMetadata: unknown
  url: string | null
}
type ArticleImportRefreshState = {
  acceptedCount: number
  acceptedSourceRecords: ArticleImportRouteSourceRecordLookup[]
  importRouteIds: string[]
}

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
    sourceRecordKey: row.legacyArticleId ?? row.id,
    url: row.url,
  }
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
          article.article_id AS legacyArticleId,
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
        FROM app.article article
        WHERE article.id IN (${getQuotedStringList(articleIdChunk).join(', ')})
        ORDER BY article.id ASC
      `)

      return [...existingRows, ...chunkRows]
    },
    Promise.resolve([]),
  )

  return new Map(
    rows.map((row) => {
      return [row.id, row]
    }),
  )
}

const getIdentifierKey = (identifier: Pick<ExistingCanonicalArticleIdentifierRow, 'kind' | 'normalizedValue'>) => {
  return `${identifier.kind}\u0000${identifier.normalizedValue}`
}

const getExistingCanonicalArticleIdentifierRows = async (tx: ArticleImportStoreTx, articleIds: string[]) => {
  const uniqueArticleIds = getUniqueValues(articleIds)

  if (uniqueArticleIds.length === 0) {
    return []
  }

  return await getValueChunks(uniqueArticleIds).reduce<Promise<ExistingCanonicalArticleIdentifierRow[]>>(
    async (rowsPromise, articleIdChunk) => {
      const rows = await rowsPromise
      const chunkRows = await tx.queryJson<ExistingCanonicalArticleIdentifierRow>(`
        SELECT
          article_id AS articleId,
          kind,
          normalized_value AS normalizedValue
        FROM app.article_identifier
        WHERE article_id IN (${getQuotedStringList(articleIdChunk).join(', ')})
          AND kind IN ('doi', 'pmid', 'arxiv')
        ORDER BY article_id ASC, kind ASC, normalized_value ASC
      `)

      return [...rows, ...chunkRows]
    },
    Promise.resolve([]),
  )
}

const getCanonicalArticleIdentifierInputs = (article: ExistingCanonicalArticleRow): ArticleIdentifierInput[] => {
  return [
    {inputKind: 'doi', source: 'article.doi', value: article.doi},
    {inputKind: 'pmid', source: 'article.pubmed_id', value: article.pubmedId},
    {inputKind: 'arxiv', source: 'article.arxiv_id', value: article.arxivId},
  ].filter((input) => {
    return input.value !== null && input.value !== undefined
  })
}

const getCanonicalArticleFieldIdentifiers = (article: ExistingCanonicalArticleRow) => {
  return normalizeSourceRowIdentifiers(getCanonicalArticleIdentifierInputs(article)).strongIdentifiers.map(
    (identifier) => {
      return {articleId: article.id, kind: identifier.kind, normalizedValue: identifier.normalizedValue}
    },
  )
}

const getCanonicalArticleIdentifiersByArticleId = (params: {
  articles: Map<string, ExistingCanonicalArticleRow>
  identifierRows: ExistingCanonicalArticleIdentifierRow[]
}) => {
  return [
    ...params.identifierRows,
    ...Array.from(params.articles.values()).flatMap(getCanonicalArticleFieldIdentifiers),
  ].reduce<Map<string, ExistingCanonicalArticleIdentifierRow[]>>((acc, identifier) => {
    const existing = acc.get(identifier.articleId) ?? []
    const existingKeys = new Set(
      existing.map((entry) => {
        return getIdentifierKey(entry)
      }),
    )

    return existingKeys.has(getIdentifierKey(identifier))
      ? acc
      : acc.set(identifier.articleId, [...existing, identifier])
  }, new Map())
}

const hasExistingSourceRecordIdentifierRemap = (params: {
  existingIdentifiers: ExistingCanonicalArticleIdentifierRow[]
  incomingIdentifiers: CanonicalArticleMatchIdentifier[]
}) => {
  return params.incomingIdentifiers.some((incomingIdentifier) => {
    const sameKindExistingIdentifiers = params.existingIdentifiers.filter((existingIdentifier) => {
      return existingIdentifier.kind === incomingIdentifier.kind
    })
    const hasSameIdentifier = sameKindExistingIdentifiers.some((existingIdentifier) => {
      return existingIdentifier.normalizedValue === incomingIdentifier.normalizedValue
    })

    return sameKindExistingIdentifiers.length > 0 && !hasSameIdentifier
  })
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

const getArticleImportRouteSourceRecordKey = (record: {importRouteId: string; sourceRecordKey: string}) => {
  return `${record.importRouteId}\u0000${record.sourceRecordKey}`
}

const getDeduplicatedSourceRecordLookups = (records: ArticleImportRouteSourceRecordLookup[]) => {
  return Array.from(
    records
      .reduce<Map<string, ArticleImportRouteSourceRecordLookup>>((acc, record) => {
        acc.set(getArticleImportRouteSourceRecordKey(record), record)
        return acc
      }, new Map())
      .values(),
  )
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
  records: ArticleImportRouteSourceRecordLookup[],
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
        WITH candidate_article(id) AS (
          VALUES ${articleIdChunk
            .map((articleId) => {
              return `(${getSqlLiteral(articleId)})`
            })
            .join(', ')}
        )
        SELECT
          current_link.article_id AS articleId,
          current_link.import_route_id AS importRouteId,
          current_link.source_record_hash AS sourceRecordHash,
          current_link.source_record_key AS sourceRecordKey
        FROM app.article_import_route current_link
        INNER JOIN candidate_article ON candidate_article.id = current_link.article_id
        WHERE current_link.import_route_id IN (${getQuotedStringList(routeIds).join(', ')})
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

const getArticleImportRouteLinkSourceRecordLookups = (records: ArticleImportRouteLinkRecord[]) => {
  return getDeduplicatedSourceRecords(records).map((record) => {
    return {importRouteId: record.importRouteId, sourceRecordKey: record.sourceRecordKey}
  })
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

const getArticleImportRouteRemapRecordFromLinkRecord = (
  record: ArticleImportRouteLinkRecord,
): ArticleImportRouteRemapRecord => {
  return {
    externalArticleId: record.externalArticleId,
    importRouteId: record.importRouteId,
    importRunId: record.importRunId,
    incomingArticleId: record.articleId,
    sourceRecordHash: record.sourceRecordHash,
    sourceRecordKey: record.sourceRecordKey,
  }
}

const getDeduplicatedRemapRecords = (records: ArticleImportRouteRemapRecord[]) => {
  return Array.from(
    records
      .reduce<Map<string, ArticleImportRouteRemapRecord>>((acc, record) => {
        acc.set(getArticleImportRouteSourceRecordKey(record), record)
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
  records: ArticleImportRouteRemapRecord[],
) => {
  await records.reduce<Promise<void>>((previousRun, record) => {
    return previousRun.then(() => {
      return tx.run(`
        UPDATE app.article_import_route_source_record
        SET
          quarantined_at = now(),
          quarantine_reason = 'source_record_remap',
          quarantine_metadata = ${getSqlLiteral({
            incomingArticleId: record.incomingArticleId,
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

  await quarantineRemappedArticleImportSourceRecords(
    tx,
    remappedRecords.map(getArticleImportRouteRemapRecordFromLinkRecord),
  )
  await upsertArticleImportRouteSourceRecords(tx, acceptedRecords, existingSourceRecords)
  await upsertArticleImportRouteCurrentLinks(tx, acceptedRecords)
}

const getArticleIdentifierInputs = (row: ScopedArticleImportStoreRow): ArticleIdentifierInput[] => {
  return [
    {inputKind: 'doi', source: 'doi', value: row.doi},
    {inputKind: 'pmid', source: 'pubmed_id', value: row.pubmedId},
    {inputKind: 'arxiv', source: 'arxiv_id', value: row.arxivId},
    {inputKind: 'biorxiv', source: 'biorxiv_id', value: row.biorxivId},
    {inputKind: 'medrxiv', source: 'medrxiv_id', value: row.medrxivId},
    {inputKind: 'url', source: 'url', value: row.url},
  ].filter((input) => {
    return input.value !== null && input.value !== undefined
  })
}

const getArticleIdentifierNormalization = (row: ScopedArticleImportStoreRow) => {
  return normalizeSourceRowIdentifiers(getArticleIdentifierInputs(row))
}

const getStrongIdentifierNormalizedValue = (
  identifierNormalization: NormalizedSourceRowIdentifiers,
  kind: ArticleStrongIdentifierKind,
) => {
  return (
    identifierNormalization.strongIdentifiers.find((identifier) => {
      return identifier.kind === kind
    })?.normalizedValue ?? null
  )
}

const getRowWithNormalizedStrongIdentifiers = (
  row: ScopedArticleImportStoreRow,
  identifierNormalization: NormalizedSourceRowIdentifiers,
): ScopedArticleImportStoreRow => {
  return {
    ...row,
    arxivId: getStrongIdentifierNormalizedValue(identifierNormalization, 'arxiv'),
    doi: getStrongIdentifierNormalizedValue(identifierNormalization, 'doi'),
    pubmedId: getStrongIdentifierNormalizedValue(identifierNormalization, 'pmid'),
  }
}

const getCanonicalArticleMatchIdentifiers = (
  row: ScopedArticleImportStoreRow,
  normalized: NormalizedSourceRowIdentifiers,
): CanonicalArticleMatchIdentifier[] => {
  return normalized.strongIdentifiers.map((identifier) => {
    return {
      evidence: identifier.evidence,
      kind: identifier.kind,
      normalizedValue: identifier.normalizedValue,
      source: identifier.evidence[0]?.source ?? row.sourceKind ?? row.importRoute,
    }
  })
}

const getCanonicalArticleImportCandidateRecord = (
  row: ScopedArticleImportStoreRow,
  index: number,
): CanonicalArticleImportCandidateRecord => {
  const identifierNormalization = getArticleIdentifierNormalization(row)
  const candidateRow = getRowWithNormalizedStrongIdentifiers(row, identifierNormalization)

  return {
    candidate: {
      articleAuthors: candidateRow.articleAuthors,
      articleCreatedAt: candidateRow.articleCreatedAt,
      articleSummary: candidateRow.articleSummary,
      articleTitle: candidateRow.articleTitle,
      allowUnidentifiedCreate: candidateRow.allowUnidentifiedCreate,
      arxivId: candidateRow.arxivId,
      biorxivId: candidateRow.biorxivId,
      candidateId: `${row.sourceRecordKey}\u0000${index}`,
      doi: candidateRow.doi,
      fullText: candidateRow.fullText,
      fullTextCharCount: candidateRow.fullTextCharCount,
      fullTextConversionAttempts: candidateRow.fullTextConversionAttempts,
      fullTextConversionError: candidateRow.fullTextConversionError,
      fullTextConversionStatus: candidateRow.fullTextConversionStatus,
      fullTextFetchedAt: candidateRow.fullTextFetchedAt,
      fullTextHtml: candidateRow.fullTextHtml,
      fullTextOriginalFormat: candidateRow.fullTextOriginalFormat,
      fullTextPDF: candidateRow.fullTextPDF,
      fullTextSource: candidateRow.fullTextSource,
      importRoute: candidateRow.importRoute,
      importRunId: candidateRow.importRunId,
      medrxivId: candidateRow.medrxivId,
      publicationStatus: candidateRow.publicationStatus,
      pubmedId: candidateRow.pubmedId,
      sourceKind: candidateRow.sourceKind,
      sourceMetadata: candidateRow.sourceMetadata,
      sourceRecordHash: candidateRow.sourceRecordHash,
      sourceRecordKey: candidateRow.sourceRecordKey,
      strongIdentifiers: getCanonicalArticleMatchIdentifiers(row, identifierNormalization),
      url: candidateRow.url,
    },
    identifierNormalization,
    row: candidateRow,
  }
}

const getIdentifierConflictQuarantineRecords = (
  record: CanonicalArticleImportCandidateRecord,
  conflict: ArticleIdentifierConflict,
) => {
  return conflict.normalizedValues.map((normalizedValue): ArticleIdentifierQuarantineRecord => {
    return {
      candidateId: record.candidate.candidateId,
      importRunId: record.row.importRunId,
      kind: conflict.kind,
      metadata: {
        candidates: conflict.candidates,
        detail: conflict.detail,
        normalizedValues: conflict.normalizedValues,
        status: conflict.status,
      },
      normalizedValue,
      reason: conflict.reason,
      sourceKind: record.row.sourceKind,
      sourceRecordHash: record.row.sourceRecordHash,
      sourceRecordKey: record.row.sourceRecordKey,
    }
  })
}

const getRejectedIdentifierKind = (rejected: RejectedArticleIdentifierNormalization) => {
  return rejected.inputKind === 'doi' || rejected.inputKind === 'pmid' || rejected.inputKind === 'arxiv'
    ? rejected.inputKind
    : rejected.inputKind === 'biorxiv' || rejected.inputKind === 'medrxiv'
      ? 'doi'
      : null
}

const getRejectedIdentifierQuarantineRecord = (
  record: CanonicalArticleImportCandidateRecord,
  rejected: RejectedArticleIdentifierNormalization,
) => {
  const kind = getRejectedIdentifierKind(rejected)
  const normalizedValue = rejected.rawValue.trim()

  return kind && rejected.reason !== 'empty' && normalizedValue !== ''
    ? {
        candidateId: record.candidate.candidateId,
        importRunId: record.row.importRunId,
        kind,
        metadata: {
          detail: rejected.detail,
          inputKind: rejected.inputKind,
          rawValue: rejected.rawValue,
          rejectionReason: rejected.reason,
          source: rejected.source,
          status: rejected.status,
        },
        normalizedValue,
        reason: `source-row-identifier-${rejected.reason}`,
        sourceKind: record.row.sourceKind,
        sourceRecordHash: record.row.sourceRecordHash,
        sourceRecordKey: record.row.sourceRecordKey,
      }
    : null
}

const getIdentifierNormalizationQuarantineRecords = (record: CanonicalArticleImportCandidateRecord) => {
  const conflictRecords = record.identifierNormalization.conflicts.flatMap((conflict) => {
    return getIdentifierConflictQuarantineRecords(record, conflict)
  })
  const rejectionRecords = record.identifierNormalization.rejected
    .map((rejected) => {
      return getRejectedIdentifierQuarantineRecord(record, rejected)
    })
    .filter((entry): entry is ArticleIdentifierQuarantineRecord => {
      return entry !== null
    })

  return [...conflictRecords, ...rejectionRecords]
}

const getIdentifierNormalizationQuarantineInsertValue = (record: ArticleIdentifierQuarantineRecord) => {
  return `(${[
    crypto.randomUUID(),
    record.sourceKind,
    record.importRunId,
    record.sourceRecordKey,
    record.sourceRecordHash,
    null,
    null,
    record.kind,
    record.normalizedValue,
    record.reason,
    record.metadata,
  ]
    .map((entry) => {
      return getSqlLiteral(entry)
    })
    .join(', ')})`
}

const insertIdentifierNormalizationQuarantineRecords = async (
  tx: ArticleImportStoreTx,
  records: ArticleIdentifierQuarantineRecord[],
) => {
  await getValueChunks(records).reduce<Promise<void>>((previousRun, recordChunk) => {
    return previousRun.then(() => {
      return recordChunk.length === 0
        ? Promise.resolve()
        : tx.run(`
          INSERT INTO app.article_canonical_match_quarantine (
            id,
            source_kind,
            import_run_id,
            source_record_key,
            source_record_hash,
            requested_article_id,
            winning_article_id,
            kind,
            normalized_value,
            reason,
            metadata
          )
          VALUES ${recordChunk.map(getIdentifierNormalizationQuarantineInsertValue).join(', ')}
        `)
    })
  }, Promise.resolve())
}

const getAcceptedIdentifierCandidateRecords = (
  candidateRecords: CanonicalArticleImportCandidateRecord[],
  quarantineRecords: ArticleIdentifierQuarantineRecord[],
) => {
  const quarantinedCandidateIds = new Set(
    quarantineRecords.map((record) => {
      return record.candidateId
    }),
  )

  return candidateRecords.filter((record) => {
    return (
      !quarantinedCandidateIds.has(record.candidate.candidateId)
      || record.identifierNormalization.strongIdentifiers.length > 0
    )
  })
}

const getAcceptedOutcomeArticleIdByCandidateId = (outcomes: CanonicalArticleMatchOutcome[]) => {
  return new Map(
    outcomes
      .filter((outcome): outcome is Extract<CanonicalArticleMatchOutcome, {status: 'create' | 'reuse'}> => {
        return outcome.status === 'create' || outcome.status === 'reuse'
      })
      .map((outcome) => {
        return [outcome.candidateId, outcome.articleId]
      }),
  )
}

const getMatchedArticleGroups = (
  candidateRecords: CanonicalArticleImportCandidateRecord[],
  articleIdByCandidateId: Map<string, string>,
) => {
  return candidateRecords.reduce<Map<string, ScopedArticleImportStoreRow[]>>((acc, record) => {
    const articleId = articleIdByCandidateId.get(record.candidate.candidateId)
    const existingRows = articleId ? (acc.get(articleId) ?? []) : []

    if (articleId) {
      acc.set(articleId, [...existingRows, record.row])
    }

    return acc
  }, new Map())
}

const getArticleImportRouteLinkRecords = (params: {
  articleIdByCandidateId: Map<string, string>
  candidateRecords: CanonicalArticleImportCandidateRecord[]
  routeIdMap: Map<string, string>
}) => {
  return params.candidateRecords
    .map((record) => {
      const articleId = params.articleIdByCandidateId.get(record.candidate.candidateId)
      const importRouteId = params.routeIdMap.get(record.row.importRoute)

      return articleId && importRouteId
        ? {
            articleId,
            externalArticleId: record.row.externalArticleId,
            importMetadata: record.row.importMetadata,
            importRouteId,
            importRunId: record.row.importRunId,
            matchMetadata: record.row.matchMetadata,
            rawPayload: record.row.rawPayload,
            sourceKind: record.row.sourceKind,
            sourceRecordHash: record.row.sourceRecordHash,
            sourceRecordKey: record.row.sourceRecordKey,
          }
        : null
    })
    .filter((value): value is ArticleImportRouteLinkRecord => {
      return value !== null
    })
}

const getArticleImportRouteSourceRecordCandidates = (params: {
  candidateRecords: CanonicalArticleImportCandidateRecord[]
  routeIdMap: Map<string, string>
}) => {
  return params.candidateRecords
    .map((candidateRecord) => {
      const importRouteId = params.routeIdMap.get(candidateRecord.row.importRoute)

      return importRouteId ? {candidateRecord, importRouteId} : null
    })
    .filter((record): record is ArticleImportRouteSourceRecordCandidate => {
      return record !== null
    })
}

const getArticleImportRouteSourceRecordCandidateKey = (record: ArticleImportRouteSourceRecordCandidate) => {
  return getArticleImportRouteSourceRecordKey({
    importRouteId: record.importRouteId,
    sourceRecordKey: record.candidateRecord.row.sourceRecordKey,
  })
}

const getArticleImportRouteRemapRecordFromSourceRecordCandidate = (
  record: ArticleImportRouteSourceRecordCandidate,
): ArticleImportRouteRemapRecord => {
  return {
    externalArticleId: record.candidateRecord.row.externalArticleId,
    importRouteId: record.importRouteId,
    importRunId: record.candidateRecord.row.importRunId,
    incomingArticleId: null,
    sourceRecordHash: record.candidateRecord.row.sourceRecordHash,
    sourceRecordKey: record.candidateRecord.row.sourceRecordKey,
  }
}

const getForcedCanonicalArticleCandidateRecord = (
  record: CanonicalArticleImportCandidateRecord,
  articleId: string,
): CanonicalArticleImportCandidateRecord => {
  return {...record, candidate: {...record.candidate, forcedArticleId: articleId}}
}

const getSourceRecordPreflightResult = async (params: {
  candidateRecords: CanonicalArticleImportCandidateRecord[]
  routeIdMap: Map<string, string>
  tx: ArticleImportStoreTx
}) => {
  const sourceRecordCandidates = getArticleImportRouteSourceRecordCandidates(params)
  const sourceRecordCandidateByCandidateId = new Map(
    sourceRecordCandidates.map((record) => {
      return [record.candidateRecord.candidate.candidateId, record]
    }),
  )
  const existingSourceRecords = await getExistingArticleImportRouteSourceRecords(
    params.tx,
    sourceRecordCandidates.map((record) => {
      return {importRouteId: record.importRouteId, sourceRecordKey: record.candidateRecord.row.sourceRecordKey}
    }),
  )
  const existingSourceRecordArticleIds = getUniqueValues(
    Array.from(existingSourceRecords.values()).map((record) => {
      return record.articleId
    }),
  )
  const existingArticles = await getExistingCanonicalArticles(params.tx, existingSourceRecordArticleIds)
  const existingIdentifierRows = await getExistingCanonicalArticleIdentifierRows(
    params.tx,
    existingSourceRecordArticleIds,
  )
  const existingIdentifiersByArticleId = getCanonicalArticleIdentifiersByArticleId({
    articles: existingArticles,
    identifierRows: existingIdentifierRows,
  })
  const remappedSourceRecordKeys = new Set(
    sourceRecordCandidates
      .filter((record) => {
        const existingRecord = existingSourceRecords.get(getArticleImportRouteSourceRecordCandidateKey(record))
        const existingIdentifiers = existingRecord
          ? (existingIdentifiersByArticleId.get(existingRecord.articleId) ?? [])
          : []

        return existingRecord
          ? hasExistingSourceRecordIdentifierRemap({
              existingIdentifiers,
              incomingIdentifiers: record.candidateRecord.candidate.strongIdentifiers,
            })
          : false
      })
      .map(getArticleImportRouteSourceRecordCandidateKey),
  )
  const remappedRecords = sourceRecordCandidates
    .filter((record) => {
      return remappedSourceRecordKeys.has(getArticleImportRouteSourceRecordCandidateKey(record))
    })
    .map(getArticleImportRouteRemapRecordFromSourceRecordCandidate)
  const acceptedCandidateRecords = params.candidateRecords
    .map((record) => {
      const sourceRecordCandidate = sourceRecordCandidateByCandidateId.get(record.candidate.candidateId)
      const sourceRecordCandidateKey = sourceRecordCandidate
        ? getArticleImportRouteSourceRecordCandidateKey(sourceRecordCandidate)
        : null
      const existingRecord = sourceRecordCandidateKey ? existingSourceRecords.get(sourceRecordCandidateKey) : null

      return sourceRecordCandidateKey && remappedSourceRecordKeys.has(sourceRecordCandidateKey)
        ? null
        : existingRecord
          ? getForcedCanonicalArticleCandidateRecord(record, existingRecord.articleId)
          : record
    })
    .filter((record): record is CanonicalArticleImportCandidateRecord => {
      return record !== null
    })

  return {acceptedCandidateRecords, existingSourceRecords, remappedRecords}
}

const getUnresolvedSourceRecordRemapRecords = (params: {
  candidateRecords: CanonicalArticleImportCandidateRecord[]
  existingSourceRecords: Map<string, ExistingArticleImportSourceRecord>
  outcomes: CanonicalArticleMatchOutcome[]
  routeIdMap: Map<string, string>
}) => {
  const outcomeByCandidateId = new Map(
    params.outcomes.map((outcome) => {
      return [outcome.candidateId, outcome]
    }),
  )

  return getArticleImportRouteSourceRecordCandidates(params)
    .filter((record) => {
      const existingRecord = params.existingSourceRecords.get(getArticleImportRouteSourceRecordCandidateKey(record))
      const outcome = outcomeByCandidateId.get(record.candidateRecord.candidate.candidateId)

      return Boolean(existingRecord && outcome?.status === 'unresolved')
    })
    .map(getArticleImportRouteRemapRecordFromSourceRecordCandidate)
}

const storeImportedArticleChunkInTx = async (tx: ArticleImportStoreTx, rows: ArticleImportStoreRow[]) => {
  if (rows.length === 0) {
    return {acceptedCount: 0, acceptedSourceRecords: [], importRouteIds: [] as string[]}
  }

  const normalizedRows = rows.map((row) => {
    return getScopedArticleImportStoreRow(getNormalizedArticleImportRow(row))
  })
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
  const candidateRecords = normalizedRows.map(getCanonicalArticleImportCandidateRecord)
  const identifierQuarantineRecords = candidateRecords.flatMap(getIdentifierNormalizationQuarantineRecords)
  const identifierAcceptedCandidateRecords = getAcceptedIdentifierCandidateRecords(
    candidateRecords,
    identifierQuarantineRecords,
  )
  const sourceRecordPreflight = await getSourceRecordPreflightResult({
    candidateRecords: identifierAcceptedCandidateRecords,
    routeIdMap,
    tx,
  })

  await insertIdentifierNormalizationQuarantineRecords(tx, identifierQuarantineRecords)

  const matchResult = await matchCanonicalArticlesWithTx(
    tx,
    sourceRecordPreflight.acceptedCandidateRecords.map((record) => {
      return record.candidate
    }),
  )
  const articleIdByCandidateId = getAcceptedOutcomeArticleIdByCandidateId(matchResult.outcomes)
  const articleGroups = getMatchedArticleGroups(sourceRecordPreflight.acceptedCandidateRecords, articleIdByCandidateId)
  const existingCanonicalArticles = await getExistingCanonicalArticles(tx, Array.from(articleGroups.keys()))
  const linkRecords = getArticleImportRouteLinkRecords({
    articleIdByCandidateId,
    candidateRecords: sourceRecordPreflight.acceptedCandidateRecords,
    routeIdMap,
  })
  const remappedSourceRecords = getDeduplicatedRemapRecords([
    ...sourceRecordPreflight.remappedRecords,
    ...getUnresolvedSourceRecordRemapRecords({
      candidateRecords: sourceRecordPreflight.acceptedCandidateRecords,
      existingSourceRecords: sourceRecordPreflight.existingSourceRecords,
      outcomes: matchResult.outcomes,
      routeIdMap,
    }),
  ])

  await updateExistingCanonicalArticlesInTx({articleGroups, existingArticles: existingCanonicalArticles, tx})

  if (linkRecords.length > 0) {
    await insertArticleImportRouteLinks(tx, linkRecords)
  }

  if (remappedSourceRecords.length > 0) {
    await quarantineRemappedArticleImportSourceRecords(tx, remappedSourceRecords)
  }

  return {
    acceptedCount: articleIdByCandidateId.size,
    acceptedSourceRecords: getArticleImportRouteLinkSourceRecordLookups(linkRecords),
    importRouteIds: Array.from(routeIdMap.values()),
  }
}

const getMergedImportRefreshState = (states: ArticleImportRefreshState[]) => {
  return {
    acceptedCount: states.reduce((sum, state) => {
      return sum + state.acceptedCount
    }, 0),
    acceptedSourceRecords: getDeduplicatedSourceRecordLookups(
      states.flatMap((state) => {
        return state.acceptedSourceRecords
      }),
    ),
    importRouteIds: getUniqueValues(
      states.flatMap((state) => {
        return state.importRouteIds
      }),
    ),
  }
}

const storeImportedArticlesInTx = async (tx: ArticleImportStoreTx, rows: ArticleImportStoreRow[]) => {
  const states = await getValueChunks(rows).reduce<Promise<ArticleImportRefreshState[]>>(
    async (statesPromise, rowChunk) => {
      const states = await statesPromise
      const state = await storeImportedArticleChunkInTx(tx, rowChunk)

      return [...states, state]
    },
    Promise.resolve([]),
  )

  return getMergedImportRefreshState(states)
}

const clearStaleImportRouteLinks = async (
  tx: ArticleImportStoreTx,
  importRouteId: string,
  sourceRecordKeys: string[],
) => {
  const sourceRecordKeyClause =
    sourceRecordKeys.length === 0
      ? ''
      : `AND source_record_key NOT IN (${getQuotedStringList(sourceRecordKeys).join(', ')})`
  const currentLinkSourceRecordKeyClause =
    sourceRecordKeys.length === 0
      ? ''
      : `AND (source_record_key IS NULL OR source_record_key NOT IN (${getQuotedStringList(sourceRecordKeys).join(', ')}))`

  await tx.run(`
    DELETE FROM app.article_import_route_source_record
    WHERE import_route_id = ${getSqlLiteral(importRouteId)}
      ${sourceRecordKeyClause}
  `)

  await tx.run(`
    DELETE FROM app.article_import_route
    WHERE import_route_id = ${getSqlLiteral(importRouteId)}
      ${currentLinkSourceRecordKeyClause}
  `)
}

const getAcceptedImportRouteSourceRecordKeys = (
  records: ArticleImportRouteSourceRecordLookup[],
  importRouteId: string,
) => {
  return getUniqueValues(
    records
      .filter((record) => {
        return record.importRouteId === importRouteId
      })
      .map((record) => {
        return record.sourceRecordKey
      }),
  )
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

  const importRefreshState =
    params.rows.length > 0
      ? await storeImportedArticlesInTx(params.tx, params.rows)
      : {acceptedCount: 0, acceptedSourceRecords: [], importRouteIds: [] as string[]}

  if (importRouteId) {
    await clearStaleImportRouteLinks(
      params.tx,
      importRouteId,
      getAcceptedImportRouteSourceRecordKeys(importRefreshState.acceptedSourceRecords, importRouteId),
    )
  }

  return {
    acceptedCount: importRefreshState.acceptedCount,
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
  const state = await storeImportedArticlesInTx(tx, rows)

  return {acceptedCount: state.acceptedCount, importRouteIds: state.importRouteIds}
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
