import {createHash} from 'node:crypto'

import type {DataSourceArticleChangeRunKind, PublicationStatus} from '../../db/schemaTypes.ts'
import {
  type ArticleIdentifierConflict,
  type ArticleIdentifierInput,
  type ArticleStrongIdentifierKind,
  type NormalizedSourceRowIdentifiers,
  normalizeSourceRowIdentifiers,
  type RejectedArticleIdentifierNormalization,
} from '../../utils/articleIdentifierNormalization.ts'
import {getArticleSourceMetadata, getOriginalDoi, normalizeDoi} from '../../utils/articleSourceMetadata.ts'
import {
  appendArticleReviewServingDeltas,
  type ArticleReviewServingFieldName,
  getArticleReviewServingMutationValueHash,
} from '../reviewServing/articleReviewServingDeltaService.ts'
import {
  getReviewImportHotFieldRow,
  type ReviewImportHotFieldInput,
  upsertReviewImportArticleHotField,
} from '../reviewServing/reviewImportHotFieldService.ts'
import {
  appendReviewServingImportRunArticleDelta,
  type ReviewServingImportRunArticleChangeKind,
  type ReviewServingSourceOperation,
} from '../reviewServing/reviewServingDeltaLedger.ts'
import type {DuckdbWorkloadContext} from '../utils/duckdbService.ts'
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
  sourceArticleCreatedAt: Date | string | null
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
type ArticleImportRouteSourceRecordRow = ArticleImportRouteLinkRecord
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
  sourceArticleCreatedAt: Date | string | null
  sourceRecordHash: string | null
  sourceRecordKey: string | null
}
type DeletedArticleImportRouteLink = ArticleImportRouteLinkRecord
type DeletedArticleImportRouteLinkRow = {
  articleId: string
  externalArticleId: string | null
  importMetadata: unknown
  importRunId: string | null
  matchMetadata: unknown
  rawPayload: unknown
  sourceArticleCreatedAt: Date | string | null
  sourceKind: string | null
  sourceRecordHash: string
  sourceRecordKey: string
}
type ReconciliationChangeLogContext = {
  dataSourceId: string
  detectedAt?: Date
  importRunId: string | null
  route: string
  runKind: DataSourceArticleChangeRunKind
}
type ExistingArticleImportSourceRecord = {
  articleId: string
  externalArticleId: string | null
  importRouteId: string
  importMetadata: unknown
  legacyArticleId: string | null
  matchMetadata: unknown
  rawPayload: unknown
  sourceArticleCreatedAt: Date | string | null
  sourceKind: string | null
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
type ArticleReferenceTableRow = {schemaName: string; tableName: string}
type ArticleImportRefreshState = {
  acceptedCount: number
  acceptedSourceRecords: ArticleImportRouteSourceRecordLookup[]
  importRouteIds: string[]
}

const articleImportBatchSize = 500

export const articleImportStoreWorkloadContext: DuckdbWorkloadContext = {
  allowsTempSpill: true,
  fallbackIntent: 'reject',
  routeOrJobKey: 'import.storeArticles',
  timeoutMs: 120_000,
  workloadClass: 'background.importStore',
}

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

const getNullableMetadataString = (metadata: unknown, keys: string[]) => {
  const record = isObjectRecord(metadata) ? metadata : {}
  const value = keys
    .map((key) => {
      return record[key]
    })
    .find((entry) => {
      return typeof entry === 'string' && entry.trim() !== ''
    })

  return typeof value === 'string' ? value : null
}

const getMetadataPathValue = (metadata: unknown, keys: readonly string[]) => {
  return keys.reduce<unknown>((value, key) => {
    return isObjectRecord(value) ? value[key] : undefined
  }, metadata)
}

const getNullableMetadataBoolean = (metadata: unknown, keys: readonly string[]) => {
  const value = getMetadataPathValue(metadata, keys)
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : null

  return typeof value === 'boolean' ? value : normalized === 'true' ? true : normalized === 'false' ? false : null
}

const getNullableMetadataInteger = (metadata: unknown, keys: string[]) => {
  const record = isObjectRecord(metadata) ? metadata : {}
  const value = keys
    .map((key) => {
      return record[key]
    })
    .find((entry) => {
      return typeof entry === 'number' || typeof entry === 'string'
    })
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number.parseInt(value, 10) : null

  return Number.isInteger(parsed) ? parsed : null
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

const getTimestampValueMs = (value: Date | string | null | undefined) => {
  if (value === null || value === undefined) {
    return null
  }

  const date = value instanceof Date ? value : new Date(value)

  return Number.isNaN(date.getTime()) ? String(value) : date.getTime()
}

const hasTimestampValueChanged = (left: Date | string | null | undefined, right: Date | string | null | undefined) => {
  return getTimestampValueMs(left) !== getTimestampValueMs(right)
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

type CanonicalArticleSnapshot = {
  articleAuthors: string[]
  articleCreatedAt: Date | string | null
  articleSummary: string | null
  articleTitle: string
  arxivId: string | null
  biorxivId: string | null
  doi: string | null
  importRoute: string | null
  medrxivId: string | null
  publicationStatus: PublicationStatus | null
  pubmedId: string | null
  sourceMetadata: unknown
  url: string | null
}

type AppliedCanonicalArticleUpdate = {
  articleId: string
  changedFields: Record<string, [unknown, unknown]>
  nextSnapshot: CanonicalArticleSnapshot
  previousSnapshot: CanonicalArticleSnapshot
}

const getCanonicalArticleSnapshot = (row: ExistingCanonicalArticleRow): CanonicalArticleSnapshot => {
  return {
    articleAuthors: getStringArrayValue(row.articleAuthors),
    articleCreatedAt: row.articleCreatedAt,
    articleSummary: row.articleSummary,
    articleTitle: row.articleTitle,
    arxivId: row.arxivId,
    biorxivId: row.biorxivId,
    doi: row.doi,
    importRoute: row.importRoute,
    medrxivId: row.medrxivId,
    publicationStatus: getPublicationStatus(row.publicationStatus),
    pubmedId: row.pubmedId,
    sourceMetadata: getJsonValue(row.sourceMetadata),
    url: row.url,
  }
}

const getCanonicalArticleChangedFields = (
  previousSnapshot: CanonicalArticleSnapshot,
  values: Partial<CanonicalArticleUpdateValues>,
) => {
  return Object.fromEntries(
    Object.entries(values).map(([fieldName, nextValue]) => {
      return [
        fieldName,
        [previousSnapshot[fieldName as keyof CanonicalArticleSnapshot] ?? null, nextValue] as [unknown, unknown],
      ]
    }),
  )
}

const isSafeSqlIdentifier = (value: string) => {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(value)
}

const getSafeArticleReferenceTableName = (row: ArticleReferenceTableRow) => {
  return isSafeSqlIdentifier(row.schemaName) && isSafeSqlIdentifier(row.tableName)
    ? `${row.schemaName}.${row.tableName}`
    : null
}

const getCanonicalArticleUpdateBlockingReferenceTables = async (tx: ArticleImportStoreTx) => {
  const rows = await tx.queryJson<ArticleReferenceTableRow>(`
    SELECT schema_name AS schemaName, table_name AS tableName
    FROM duckdb_constraints()
    WHERE constraint_type = 'FOREIGN KEY'
      AND referenced_table = 'article'
    ORDER BY schema_name ASC, table_name ASC
  `)

  return rows.map(getSafeArticleReferenceTableName).filter((tableName): tableName is string => {
    return tableName !== null
  })
}

const getCanonicalArticleUpdateBlockedArticleIds = async (tx: ArticleImportStoreTx, articleIds: string[]) => {
  const uniqueArticleIds = getUniqueValues(articleIds)

  if (uniqueArticleIds.length === 0) {
    return new Set<string>()
  }

  const referenceTables = await getCanonicalArticleUpdateBlockingReferenceTables(tx)

  if (referenceTables.length === 0) {
    return new Set<string>()
  }

  const rows = await getValueChunks(uniqueArticleIds).reduce<Promise<Array<{articleId: string}>>>(
    async (rowsPromise, articleIdChunk) => {
      const existingRows = await rowsPromise
      const quotedArticleIds = getQuotedStringList(articleIdChunk).join(', ')
      const chunkRows = await tx.queryJson<{articleId: string}>(`
        ${referenceTables
          .map((tableName) => {
            return `SELECT article_id AS articleId FROM ${tableName} WHERE article_id IN (${quotedArticleIds})`
          })
          .join('\nUNION\n')}
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

const updateExistingCanonicalArticlesInTx = async (params: {
  articleGroups: Map<string, ScopedArticleImportStoreRow[]>
  existingArticles: Map<string, ExistingCanonicalArticleRow>
  tx: ArticleImportStoreTx
}) => {
  const candidateUpdates = Array.from(params.articleGroups.entries())
    .map((entry) => {
      const current = params.existingArticles.get(entry[0])
      const values = current ? getChangedCanonicalArticleUpdateValues({current, rows: entry[1]}) : null

      return current && values && Object.keys(values).length > 0 ? {current, values} : null
    })
    .filter((entry): entry is {current: ExistingCanonicalArticleRow; values: Partial<CanonicalArticleUpdateValues>} => {
      return entry !== null
    })
  const blockedArticleIds = await getCanonicalArticleUpdateBlockedArticleIds(
    params.tx,
    candidateUpdates.map((update) => {
      return update.current.id
    }),
  )
  const updates = candidateUpdates.filter((update) => {
    return !blockedArticleIds.has(update.current.id)
  })

  return updates.reduce<Promise<AppliedCanonicalArticleUpdate[]>>((previousRun, update) => {
    return previousRun.then(async (appliedUpdates) => {
      const assignments = Object.entries(update.values).map((entry) => {
        return `${canonicalArticleUpdateColumnMap[entry[0] as CanonicalArticleUpdateKey]} = ${getSqlLiteral(entry[1])}`
      })
      const changedFields = Object.keys(update.values).filter(
        (fieldName): fieldName is ArticleReviewServingFieldName => {
          return [
            'articleAuthors',
            'articleSummary',
            'articleTitle',
            'arxivId',
            'biorxivId',
            'doi',
            'medrxivId',
            'publicationStatus',
            'pubmedId',
            'sourceMetadata',
            'url',
          ].includes(fieldName)
        },
      )
      const sourceUpdatedAt = new Date()
      const previousSnapshot = getCanonicalArticleSnapshot(update.current)
      const nextSnapshot = {...previousSnapshot, ...update.values}

      await params.tx.run(`
        UPDATE app.article
        SET
          ${assignments.join(',\n          ')},
          updated_at = now()
        WHERE id = ${getSqlLiteral(update.current.id)}
      `)
      await appendArticleReviewServingDeltas(params.tx, {
        articleId: update.current.id,
        changedFields,
        sourceMutationKey: `articleImportStoreService|canonicalArticle|${update.current.id}|${sourceUpdatedAt.toISOString()}|${getArticleReviewServingMutationValueHash(update.values)}`,
        sourceOperation: 'update',
        sourceUpdatedAt,
      })

      return [
        ...appliedUpdates,
        {
          articleId: update.current.id,
          changedFields: getCanonicalArticleChangedFields(previousSnapshot, update.values),
          nextSnapshot,
          previousSnapshot,
        },
      ]
    })
  }, Promise.resolve([]))
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
  'source_article_created_at',
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
  'source_article_created_at',
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
    record.sourceArticleCreatedAt,
    record.rawPayload,
  ]
    .map((value) => {
      return getSqlLiteral(value)
    })
    .join(', ')})`
}

const getArticleImportRouteDeltaPartition = (importRouteId: string) => {
  return `import-route:${importRouteId}`
}

const getArticleImportRouteDeltaTypedKey = (
  record: Pick<ArticleImportRouteLinkRecord, 'articleId' | 'importRouteId' | 'sourceRecordKey'>,
) => {
  return {
    articleId: record.articleId,
    importRouteId: record.importRouteId,
    importSourceRecordKey: record.sourceRecordKey,
  }
}

const changedImportRouteRankFilterFields = [
  'articleTitle',
  'duplicateFlag',
  'duplicateKey',
  'filterBucketKey',
  'filterBucketValue',
  'journalTitle',
  'publicationYear',
  'selectedRankKey',
  'sourceKind',
  'sourceRecordHash',
] as const

const getArticleImportRouteSourceRecordMutationKey = (
  record: Pick<ArticleImportRouteLinkRecord, 'importRouteId' | 'importRunId' | 'sourceRecordHash' | 'sourceRecordKey'>,
) => {
  return [record.importRouteId, record.importRunId, record.sourceRecordKey, record.sourceRecordHash].join('|')
}

const getArticleImportRouteCurrentLinkMutationKey = (
  record: Pick<
    ArticleImportRouteLinkRecord,
    'articleId' | 'importRouteId' | 'importRunId' | 'sourceRecordHash' | 'sourceRecordKey'
  >,
) => {
  return [
    record.articleId,
    record.importRouteId,
    record.importRunId,
    record.sourceRecordKey,
    record.sourceRecordHash,
  ].join('|')
}

const getDataSourceArticleChangeLogId = (input: {
  articleId: string | null
  changeKind: string
  dataSourceId: string
  externalArticleId: string | null
  nextSourceRecordHash: string | null
  previousSourceRecordHash: string | null
  route: string
  runKind: string
  sourceRecordKey: string | null
  importRunId: string | null
}) => {
  const digest = createHash('sha256')
    .update(
      JSON.stringify({
        articleId: input.articleId,
        changeKind: input.changeKind,
        dataSourceId: input.dataSourceId,
        externalArticleId: input.externalArticleId,
        nextSourceRecordHash: input.nextSourceRecordHash,
        previousSourceRecordHash: input.previousSourceRecordHash,
        route: input.route,
        runKind: input.runKind,
        sourceRecordKey: input.sourceRecordKey,
        importRunId: input.importRunId,
      }),
    )
    .digest('hex')

  return `data-source-change-${digest.slice(0, 32)}`
}

const getJsonSqlLiteralForArticleImport = (value: unknown): string => {
  return value === null || value === undefined ? 'NULL' : `CAST(${getSqlLiteral(JSON.stringify(value))} AS JSON)`
}

const getArticleImportRouteLinkHotFieldInput = (
  record: ArticleImportRouteLinkRecord,
  tombstone = false,
): ReviewImportHotFieldInput => {
  const duplicateKey = getNullableMetadataString(record.matchMetadata, ['duplicateKey'])

  return {
    articleId: record.articleId,
    articleTitle: getNullableMetadataString(record.importMetadata, ['articleTitle', 'title']),
    conflictFlag: getNullableMetadataBoolean(record.importMetadata, ['covidence', 'hasStudyDecisionConflict']),
    duplicateFlag:
      duplicateKey !== null
      || getNullableMetadataBoolean(record.importMetadata, ['covidence', 'hasDuplicateStudyRecords']),
    duplicateKey,
    externalId: record.externalArticleId,
    filterBucketKey: record.sourceKind ? 'source_kind' : null,
    filterBucketValue: record.sourceKind,
    importRouteId: record.importRouteId,
    journalTitle: getNullableMetadataString(record.importMetadata, ['journalTitle', 'journal', 'journalName']),
    publicationYear: getNullableMetadataInteger(record.importMetadata, ['publicationYear', 'year']),
    sourceKind: record.sourceKind,
    sourceRecordHash: record.sourceRecordHash,
    sourceRecordKey: record.sourceRecordKey,
    tombstone,
  }
}

const appendImportRouteArticleDelta = async (params: {
  changeKind: ReviewServingImportRunArticleChangeKind
  record: ArticleImportRouteLinkRecord
  sourceMutationKey: string
  sourceOperation: ReviewServingSourceOperation
  sourceTable: string
  tombstone?: boolean
  tx: ArticleImportStoreTx
}) => {
  const hotFieldRow = getReviewImportHotFieldRow(
    getArticleImportRouteLinkHotFieldInput(params.record, params.tombstone),
  )

  await appendReviewServingImportRunArticleDelta(params.tx, {
    articleId: params.record.articleId,
    changeKind: params.changeKind,
    importRouteId: params.record.importRouteId,
    importRunId: params.record.importRunId,
    payloadJson: {
      changedRankFilterFields:
        params.changeKind === 'importRoute.article.rankFields.updated' ? changedImportRouteRankFilterFields : undefined,
      externalArticleId: params.record.externalArticleId,
      importSourceRecordKey: params.record.sourceRecordKey,
      sourceKind: params.record.sourceKind,
      sourceRecordKey: params.record.sourceRecordKey,
    },
    payloadVersion: 1,
    publicationYear: hotFieldRow.publicationYear,
    selectedRankKey: hotFieldRow.selectedRankKey,
    sourceMutationKey: params.sourceMutationKey,
    sourceOperation: params.sourceOperation,
    sourcePartition: getArticleImportRouteDeltaPartition(params.record.importRouteId),
    sourceRecordHash: params.record.sourceRecordHash,
    sourceRecordKey: params.record.sourceRecordKey,
    sourceRowId: `${params.record.importRouteId}|${params.record.sourceRecordKey}`,
    sourceTable: params.sourceTable,
    tombstone: params.tombstone,
    typedKey:
      params.changeKind === 'importRoute.article.rankFields.updated'
        ? {
            ...getArticleImportRouteDeltaTypedKey(params.record),
            changedRankFilterFields: changedImportRouteRankFilterFields,
          }
        : getArticleImportRouteDeltaTypedKey(params.record),
  })
}

const insertSourceRecordDeletedChangeLogs = async (
  tx: ArticleImportStoreTx,
  records: DeletedArticleImportRouteLink[],
  context: ReconciliationChangeLogContext | null | undefined,
) => {
  if (!context || records.length === 0) {
    return
  }

  const detectedAt = context.detectedAt ?? new Date()
  const deduplicatedRecords = getDeduplicatedSourceRecords(records)

  await getValueChunks(deduplicatedRecords).reduce<Promise<void>>((previousRun, recordChunk) => {
    return previousRun.then(() => {
      return recordChunk.length === 0
        ? Promise.resolve()
        : tx.run(`
          INSERT INTO app.data_source_article_change_log (
            id,
            data_source_id,
            route,
            import_route_id,
            article_id,
            external_article_id,
            source_record_key,
            change_kind,
            previous_source_record_hash,
            next_source_record_hash,
            changed_fields,
            previous_snapshot,
            next_snapshot,
            import_run_id,
            run_kind,
            detected_at,
            created_at
          )
          VALUES ${recordChunk
            .map((record) => {
              const id = getDataSourceArticleChangeLogId({
                articleId: record.articleId,
                changeKind: 'source_record_deleted',
                dataSourceId: context.dataSourceId,
                externalArticleId: record.externalArticleId,
                nextSourceRecordHash: null,
                previousSourceRecordHash: record.sourceRecordHash,
                route: context.route,
                runKind: context.runKind,
                sourceRecordKey: record.sourceRecordKey,
                importRunId: context.importRunId,
              })
              const previousSnapshot = {
                externalArticleId: record.externalArticleId,
                importMetadata: record.importMetadata,
                matchMetadata: record.matchMetadata,
                rawPayload: record.rawPayload,
                sourceArticleCreatedAt: record.sourceArticleCreatedAt,
                sourceKind: record.sourceKind,
              }

              return `(${[
                id,
                context.dataSourceId,
                context.route,
                record.importRouteId,
                record.articleId,
                record.externalArticleId,
                record.sourceRecordKey,
                'source_record_deleted',
                record.sourceRecordHash,
                null,
                getJsonSqlLiteralForArticleImport(null),
                getJsonSqlLiteralForArticleImport(previousSnapshot),
                getJsonSqlLiteralForArticleImport(null),
                context.importRunId,
                context.runKind,
                detectedAt,
                detectedAt,
              ]
                .map((value, index) => {
                  return index >= 10 && index <= 12 ? String(value) : getSqlLiteral(value)
                })
                .join(', ')})`
            })
            .join(', ')}
          ON CONFLICT(id) DO NOTHING
        `)
    })
  }, Promise.resolve())
}

const getArticleChangeLogSourceRecordByArticleId = (records: ArticleImportRouteLinkRecord[]) => {
  return [...records]
    .sort((left, right) => {
      return left.sourceRecordKey.localeCompare(right.sourceRecordKey)
    })
    .reduce<Map<string, ArticleImportRouteLinkRecord>>((recordsByArticleId, record) => {
      return recordsByArticleId.has(record.articleId)
        ? recordsByArticleId
        : recordsByArticleId.set(record.articleId, record)
    }, new Map())
}

const insertReconciliationCanonicalArticleChangeLogs = async (params: {
  canonicalUpdates: AppliedCanonicalArticleUpdate[]
  context: ReconciliationChangeLogContext | null | undefined
  createdArticles: ExistingCanonicalArticleRow[]
  linkRecords: ArticleImportRouteLinkRecord[]
  tx: ArticleImportStoreTx
}) => {
  const canonicalUpdates = params.canonicalUpdates ?? []

  if (!params.context || (params.createdArticles.length === 0 && canonicalUpdates.length === 0)) {
    return
  }

  const sourceRecordByArticleId = getArticleChangeLogSourceRecordByArticleId(params.linkRecords)
  const detectedAt = params.context.detectedAt ?? new Date()
  const records = [
    ...params.createdArticles.map((article) => {
      const sourceRecord = sourceRecordByArticleId.get(article.id)

      return {
        articleId: article.id,
        changeKind: 'article_added' as const,
        changedFields: null,
        externalArticleId: sourceRecord?.externalArticleId ?? null,
        importRouteId: sourceRecord?.importRouteId ?? null,
        nextSnapshot: getCanonicalArticleSnapshot(article),
        nextSourceRecordHash: sourceRecord?.sourceRecordHash ?? null,
        previousSnapshot: null,
        previousSourceRecordHash: null,
        sourceRecordKey: sourceRecord?.sourceRecordKey ?? null,
      }
    }),
    ...canonicalUpdates.map((update) => {
      const sourceRecord = sourceRecordByArticleId.get(update.articleId)

      return {
        articleId: update.articleId,
        changeKind: 'canonical_article_changed' as const,
        changedFields: update.changedFields,
        externalArticleId: sourceRecord?.externalArticleId ?? null,
        importRouteId: sourceRecord?.importRouteId ?? null,
        nextSnapshot: update.nextSnapshot,
        nextSourceRecordHash: sourceRecord?.sourceRecordHash ?? null,
        previousSnapshot: update.previousSnapshot,
        previousSourceRecordHash: null,
        sourceRecordKey: sourceRecord?.sourceRecordKey ?? null,
      }
    }),
  ]

  await getValueChunks(records).reduce<Promise<void>>((previousRun, recordChunk) => {
    return previousRun.then(() => {
      return recordChunk.length === 0
        ? Promise.resolve()
        : params.tx.run(`
          INSERT INTO app.data_source_article_change_log (
            id,
            data_source_id,
            route,
            import_route_id,
            article_id,
            external_article_id,
            source_record_key,
            change_kind,
            previous_source_record_hash,
            next_source_record_hash,
            changed_fields,
            previous_snapshot,
            next_snapshot,
            import_run_id,
            run_kind,
            detected_at,
            created_at
          )
          VALUES ${recordChunk
            .map((record) => {
              const id = getDataSourceArticleChangeLogId({
                articleId: record.articleId,
                changeKind: record.changeKind,
                dataSourceId: params.context.dataSourceId,
                externalArticleId: record.externalArticleId,
                nextSourceRecordHash: record.nextSourceRecordHash,
                previousSourceRecordHash: record.previousSourceRecordHash,
                route: params.context.route,
                runKind: params.context.runKind,
                sourceRecordKey: record.sourceRecordKey,
                importRunId: params.context.importRunId,
              })

              return `(${[
                id,
                params.context.dataSourceId,
                params.context.route,
                record.importRouteId,
                record.articleId,
                record.externalArticleId,
                record.sourceRecordKey,
                record.changeKind,
                record.previousSourceRecordHash,
                record.nextSourceRecordHash,
                getJsonSqlLiteralForArticleImport(record.changedFields),
                getJsonSqlLiteralForArticleImport(record.previousSnapshot),
                getJsonSqlLiteralForArticleImport(record.nextSnapshot),
                params.context.importRunId,
                params.context.runKind,
                detectedAt,
                detectedAt,
              ]
                .map((value, index) => {
                  return index >= 10 && index <= 12 ? String(value) : getSqlLiteral(value)
                })
                .join(', ')})`
            })
            .join(', ')}
          ON CONFLICT(id) DO NOTHING
        `)
    })
  }, Promise.resolve())
}

const getSourceRecordSnapshot = (
  record:
    | ExistingArticleImportSourceRecord
    | Pick<
        ScopedArticleImportStoreRow,
        'articleCreatedAt' | 'externalArticleId' | 'importMetadata' | 'matchMetadata' | 'rawPayload' | 'sourceKind'
      >,
) => {
  return {
    externalArticleId: record.externalArticleId,
    importMetadata: getJsonValue(record.importMetadata),
    matchMetadata: getJsonValue(record.matchMetadata),
    rawPayload: getJsonValue(record.rawPayload),
    sourceArticleCreatedAt:
      'sourceArticleCreatedAt' in record ? record.sourceArticleCreatedAt : (record.articleCreatedAt ?? null),
    sourceKind: record.sourceKind,
  }
}

const insertReconciliationSourceRecordChangeLogs = async (params: {
  context: ReconciliationChangeLogContext | null | undefined
  importRouteId: string
  incomingRecords: ScopedArticleImportStoreRow[]
  tx: ArticleImportStoreTx
}) => {
  if (!params.context || params.incomingRecords.length === 0) {
    return
  }

  const incomingLookups = params.incomingRecords.map((record) => {
    return {importRouteId: params.importRouteId, sourceRecordKey: record.sourceRecordKey}
  })
  const existingSourceRecords = await getExistingArticleImportRouteSourceRecords(params.tx, incomingLookups)
  const changedRecords = params.incomingRecords.flatMap((record) => {
    const existing = existingSourceRecords.get(
      getArticleImportRouteSourceRecordKey({
        importRouteId: params.importRouteId,
        sourceRecordKey: record.sourceRecordKey,
      }),
    )

    return existing && existing.sourceRecordHash !== record.sourceRecordHash
      ? [
          {
            articleId: existing.articleId,
            changeKind: 'source_record_changed' as const,
            existing,
            nextHash: record.sourceRecordHash,
            nextSnapshot: getSourceRecordSnapshot(record),
            previousHash: existing.sourceRecordHash,
            previousSnapshot: getSourceRecordSnapshot(existing),
            record,
          },
        ]
      : []
  })
  const newRecords = params.incomingRecords.filter((record) => {
    return !existingSourceRecords.has(
      getArticleImportRouteSourceRecordKey({
        importRouteId: params.importRouteId,
        sourceRecordKey: record.sourceRecordKey,
      }),
    )
  })
  const restoredRows =
    newRecords.length === 0
      ? []
      : await getValueChunks(
          newRecords.map((record) => {
            return record.sourceRecordKey
          }),
        ).reduce<
          Promise<Array<{articleId: string | null; previousSourceRecordHash: string | null; sourceRecordKey: string}>>
        >(async (rowsPromise, sourceRecordKeyChunk) => {
          const rows = await rowsPromise
          const chunkRows = await params.tx.queryJson<{
            articleId: string | null
            previousSourceRecordHash: string | null
            sourceRecordKey: string
          }>(`
            SELECT
              article_id AS articleId,
              previous_source_record_hash AS previousSourceRecordHash,
              source_record_key AS sourceRecordKey
            FROM app.data_source_article_change_log
            WHERE data_source_id = ${getSqlLiteral(params.context.dataSourceId)}
              AND route = ${getSqlLiteral(params.context.route)}
              AND change_kind = 'source_record_deleted'
              AND source_record_key IN (${getQuotedStringList(sourceRecordKeyChunk).join(', ')})
            ORDER BY detected_at DESC, created_at DESC, id ASC
          `)

          return [...rows, ...chunkRows]
        }, Promise.resolve([]))
  const restoredSourceRecordKeys = new Set(
    restoredRows.map((row) => {
      return row.sourceRecordKey
    }),
  )
  const previousRestoredHashBySourceRecordKey = restoredRows.reduce<Map<string, string | null>>((hashesByKey, row) => {
    if (!hashesByKey.has(row.sourceRecordKey)) {
      hashesByKey.set(row.sourceRecordKey, row.previousSourceRecordHash)
    }
    return hashesByKey
  }, new Map())
  const previousRestoredArticleIdBySourceRecordKey = restoredRows.reduce<Map<string, string | null>>(
    (articleIdsByKey, row) => {
      if (!articleIdsByKey.has(row.sourceRecordKey)) {
        articleIdsByKey.set(row.sourceRecordKey, row.articleId)
      }
      return articleIdsByKey
    },
    new Map(),
  )
  const restoredRecords = newRecords
    .filter((record) => {
      return restoredSourceRecordKeys.has(record.sourceRecordKey)
    })
    .map((record) => {
      return {
        articleId: previousRestoredArticleIdBySourceRecordKey.get(record.sourceRecordKey) ?? null,
        changeKind: 'source_record_restored' as const,
        nextHash: record.sourceRecordHash,
        nextSnapshot: getSourceRecordSnapshot(record),
        previousHash: previousRestoredHashBySourceRecordKey.get(record.sourceRecordKey) ?? null,
        previousSnapshot: null,
        record,
      }
    })
  const detectedAt = params.context.detectedAt ?? new Date()
  const logRecords = [...changedRecords, ...restoredRecords]

  await getValueChunks(logRecords).reduce<Promise<void>>((previousRun, recordChunk) => {
    return previousRun.then(() => {
      return recordChunk.length === 0
        ? Promise.resolve()
        : params.tx.run(`
          INSERT INTO app.data_source_article_change_log (
            id,
            data_source_id,
            route,
            import_route_id,
            article_id,
            external_article_id,
            source_record_key,
            change_kind,
            previous_source_record_hash,
            next_source_record_hash,
            changed_fields,
            previous_snapshot,
            next_snapshot,
            import_run_id,
            run_kind,
            detected_at,
            created_at
          )
          VALUES ${recordChunk
            .map((entry) => {
              const id = getDataSourceArticleChangeLogId({
                articleId: null,
                changeKind: entry.changeKind,
                dataSourceId: params.context.dataSourceId,
                externalArticleId: entry.record.externalArticleId,
                nextSourceRecordHash: entry.nextHash,
                previousSourceRecordHash: entry.previousHash,
                route: params.context.route,
                runKind: params.context.runKind,
                sourceRecordKey: entry.record.sourceRecordKey,
                importRunId: params.context.importRunId,
              })
              const changedFields = {sourceRecordHash: [entry.previousHash, entry.nextHash]}

              return `(${[
                id,
                params.context.dataSourceId,
                params.context.route,
                params.importRouteId,
                entry.articleId,
                entry.record.externalArticleId,
                entry.record.sourceRecordKey,
                entry.changeKind,
                entry.previousHash,
                entry.nextHash,
                getJsonSqlLiteralForArticleImport(changedFields),
                getJsonSqlLiteralForArticleImport(entry.previousSnapshot),
                getJsonSqlLiteralForArticleImport(entry.nextSnapshot),
                params.context.importRunId,
                params.context.runKind,
                detectedAt,
                detectedAt,
              ]
                .map((value, index) => {
                  return index >= 10 && index <= 12 ? String(value) : getSqlLiteral(value)
                })
                .join(', ')})`
            })
            .join(', ')}
          ON CONFLICT(id) DO NOTHING
        `)
    })
  }, Promise.resolve())
}

const upsertReviewImportArticleHotFields = async (
  tx: ArticleImportStoreTx,
  records: ArticleImportRouteLinkRecord[],
) => {
  await getValueChunks(records).reduce<Promise<void>>((previousRun, recordChunk) => {
    return previousRun.then(() => {
      return recordChunk.reduce<Promise<void>>((previousRecordRun, record) => {
        return previousRecordRun.then(() => {
          return upsertReviewImportArticleHotField(tx, getArticleImportRouteLinkHotFieldInput(record))
        })
      }, Promise.resolve())
    })
  }, Promise.resolve())
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
          source_record.external_article_id AS externalArticleId,
          source_record.import_route_id AS importRouteId,
          TO_JSON(source_record.import_metadata) AS importMetadata,
          article.article_id AS legacyArticleId,
          TO_JSON(source_record.match_metadata) AS matchMetadata,
          TO_JSON(source_record.raw_payload) AS rawPayload,
          source_record.source_article_created_at AS sourceArticleCreatedAt,
          source_record.source_kind AS sourceKind,
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
          current_link.source_article_created_at AS sourceArticleCreatedAt,
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
  const recordsToAdd = deduplicatedRecords.filter((record) => {
    return !existingLinks.has(getArticleImportRouteCurrentLinkKey(record))
  })
  const recordsToUpdate = deduplicatedRecords.filter((record) => {
    const existingLink = existingLinks.get(getArticleImportRouteCurrentLinkKey(record))

    return Boolean(existingLink && existingLink.sourceRecordKey !== record.sourceRecordKey)
  })
  const recordsToWrite = deduplicatedRecords.filter((record) => {
    const existingLink = existingLinks.get(getArticleImportRouteCurrentLinkKey(record))

    return (
      !existingLink
      || existingLink.sourceRecordKey !== record.sourceRecordKey
      || existingLink.sourceRecordHash !== record.sourceRecordHash
      || hasTimestampValueChanged(existingLink.sourceArticleCreatedAt, record.sourceArticleCreatedAt)
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
            source_article_created_at = excluded.source_article_created_at,
            raw_payload = excluded.raw_payload,
            updated_at = now()
        `)
    })
  }, Promise.resolve())

  await recordsToAdd.reduce<Promise<void>>((previousRun, record) => {
    return previousRun.then(() => {
      return appendImportRouteArticleDelta({
        changeKind: 'importRoute.article.added',
        record,
        sourceMutationKey: getArticleImportRouteCurrentLinkMutationKey(record),
        sourceOperation: 'insert',
        sourceTable: 'app.article_import_route',
        tx,
      })
    })
  }, Promise.resolve())
  await recordsToUpdate.reduce<Promise<void>>((previousRun, record) => {
    return previousRun.then(() => {
      return appendImportRouteArticleDelta({
        changeKind: 'importRoute.article.rankFields.updated',
        record,
        sourceMutationKey: getArticleImportRouteCurrentLinkMutationKey(record),
        sourceOperation: 'update',
        sourceTable: 'app.article_import_route',
        tx,
      })
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

    return (
      !existingRecord
      || existingRecord.sourceRecordHash !== record.sourceRecordHash
      || hasTimestampValueChanged(existingRecord.sourceArticleCreatedAt, record.sourceArticleCreatedAt)
    )
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
            source_article_created_at = excluded.source_article_created_at,
            raw_payload = excluded.raw_payload,
            quarantined_at = NULL,
            quarantine_reason = NULL,
            quarantine_metadata = NULL,
            updated_at = now()
        `)
    })
  }, Promise.resolve())

  await upsertReviewImportArticleHotFields(tx, deduplicatedRecords)
  await recordsToWrite.reduce<Promise<void>>((previousRun, record) => {
    return previousRun.then(() => {
      return appendImportRouteArticleDelta({
        changeKind: 'importRoute.article.rankFields.updated',
        record,
        sourceMutationKey: getArticleImportRouteSourceRecordMutationKey(record),
        sourceOperation: 'upsert',
        sourceTable: 'app.article_import_route_source_record',
        tx,
      })
    })
  }, Promise.resolve())
}

const quarantineRemappedArticleImportSourceRecords = async (
  tx: ArticleImportStoreTx,
  records: ArticleImportRouteRemapRecord[],
) => {
  const remappedExistingRows = await getValueChunks(records).reduce<Promise<ArticleImportRouteSourceRecordRow[]>>(
    async (previousRows, recordChunk) => {
      const rows = await previousRows
      const chunkRows = await tx.queryJson<{
        articleId: string
        externalArticleId: string | null
        importMetadata: unknown
        importRouteId: string
        importRunId: string | null
        matchMetadata: unknown
        rawPayload: unknown
        sourceArticleCreatedAt: Date | string | null
        sourceKind: string | null
        sourceRecordHash: string
        sourceRecordKey: string
      }>(`
        SELECT
          article_id AS articleId,
          external_article_id AS externalArticleId,
          TO_JSON(import_metadata) AS importMetadata,
          import_route_id AS importRouteId,
          import_run_id AS importRunId,
          TO_JSON(match_metadata) AS matchMetadata,
          TO_JSON(raw_payload) AS rawPayload,
          source_article_created_at AS sourceArticleCreatedAt,
          source_kind AS sourceKind,
          source_record_hash AS sourceRecordHash,
          source_record_key AS sourceRecordKey
        FROM app.article_import_route_source_record
        WHERE ${recordChunk
          .map((record) => {
            return `(
              import_route_id = ${getSqlLiteral(record.importRouteId)}
              AND source_record_key = ${getSqlLiteral(record.sourceRecordKey)}
            )`
          })
          .join(' OR ')}
      `)

      return [
        ...rows,
        ...chunkRows.map((row) => {
          return {
            ...row,
            importMetadata: getJsonValue(row.importMetadata),
            matchMetadata: getJsonValue(row.matchMetadata),
            rawPayload: getJsonValue(row.rawPayload),
          }
        }),
      ]
    },
    Promise.resolve([]),
  )

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

  await remappedExistingRows.reduce<Promise<void>>((previousRun, record) => {
    return previousRun.then(async () => {
      await upsertReviewImportArticleHotField(tx, getArticleImportRouteLinkHotFieldInput(record, true))
      await appendImportRouteArticleDelta({
        changeKind: 'importRoute.article.rankFields.updated',
        record,
        sourceMutationKey: `sourceRecordRemap|${getArticleImportRouteSourceRecordMutationKey(record)}`,
        sourceOperation: 'update',
        sourceTable: 'app.article_import_route_source_record',
        tombstone: true,
        tx,
      })
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
            sourceArticleCreatedAt: record.row.articleCreatedAt ?? null,
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

const storeImportedArticleChunkInTx = async (
  tx: ArticleImportStoreTx,
  rows: ArticleImportStoreRow[],
  options: {changeLogContext?: ReconciliationChangeLogContext | null} = {},
) => {
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

  const canonicalUpdates = await updateExistingCanonicalArticlesInTx({
    articleGroups,
    existingArticles: existingCanonicalArticles,
    tx,
  })

  if (linkRecords.length > 0) {
    await insertArticleImportRouteLinks(tx, linkRecords)
  }

  await insertReconciliationCanonicalArticleChangeLogs({
    canonicalUpdates,
    context: options.changeLogContext,
    createdArticles: Array.from(existingCanonicalArticles.values()).filter((article) => {
      return matchResult.outcomes.some((outcome) => {
        return outcome.status === 'create' && outcome.articleId === article.id
      })
    }),
    linkRecords,
    tx,
  })

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

const storeImportedArticlesInTx = async (
  tx: ArticleImportStoreTx,
  rows: ArticleImportStoreRow[],
  options: {changeLogContext?: ReconciliationChangeLogContext | null} = {},
) => {
  const implicitImportRunId = globalThis.crypto.randomUUID()
  const rowsWithImportRunIds = rows.map((row) => {
    return {...row, importRunId: row.importRunId ?? implicitImportRunId}
  })
  const states = await getValueChunks(rowsWithImportRunIds).reduce<Promise<ArticleImportRefreshState[]>>(
    async (statesPromise, rowChunk) => {
      const states = await statesPromise
      const state = await storeImportedArticleChunkInTx(tx, rowChunk, options)

      return [...states, state]
    },
    Promise.resolve([]),
  )

  return getMergedImportRefreshState(states)
}

const reconciliationSeenSourceRecordKeyTableName = 'reconciliation_seen_source_record_keys'

const insertReconciliationSeenSourceRecordKeys = async (tx: ArticleImportStoreTx, sourceRecordKeys: string[]) => {
  const uniqueKeys = getUniqueValues(sourceRecordKeys).filter((key) => {
    return key.trim() !== ''
  })

  await getValueChunks(uniqueKeys).reduce<Promise<void>>(async (previousRun, keyChunk) => {
    await previousRun

    if (keyChunk.length === 0) {
      return
    }

    await tx.run(`
      INSERT INTO ${reconciliationSeenSourceRecordKeyTableName} (source_record_key)
      SELECT source_record_key
      FROM (
        VALUES ${keyChunk
          .map((sourceRecordKey) => {
            return `(${getSqlLiteral(sourceRecordKey)})`
          })
          .join(', ')}
      ) AS incoming(source_record_key)
    `)
  }, Promise.resolve())
}

const createReconciliationSeenSourceRecordKeyTable = async (
  tx: ArticleImportStoreTx,
  sourceRecordKeys: string[],
  sourceRecordKeyBatches: Iterable<string[]> | undefined,
) => {
  await tx.run(`
    CREATE OR REPLACE TEMP TABLE ${reconciliationSeenSourceRecordKeyTableName} (
      source_record_key TEXT PRIMARY KEY
    )
  `)

  await insertReconciliationSeenSourceRecordKeys(tx, sourceRecordKeys)

  if (sourceRecordKeyBatches) {
    for (const sourceRecordKeyBatch of sourceRecordKeyBatches) {
      await insertReconciliationSeenSourceRecordKeys(tx, sourceRecordKeyBatch)
    }
  }

  return reconciliationSeenSourceRecordKeyTableName
}

const clearStaleImportRouteLinks = async (
  tx: ArticleImportStoreTx,
  importRouteId: string,
  sourceRecordKeys: string[],
  options: {
    changeLogContext?: ReconciliationChangeLogContext | null
    periodEnd?: Date | null
    periodStart?: Date | null
    seenSourceRecordKeyTableName?: string | null
  } = {},
) => {
  const sourceRecordKeyClause = options.seenSourceRecordKeyTableName
    ? `AND NOT EXISTS (
        SELECT 1
        FROM ${options.seenSourceRecordKeyTableName} seen_source_record_key
        WHERE seen_source_record_key.source_record_key = source_record.source_record_key
      )`
    : sourceRecordKeys.length === 0
      ? ''
      : `AND source_record_key NOT IN (${getQuotedStringList(sourceRecordKeys).join(', ')})`
  const currentLinkSourceRecordKeyClause = options.seenSourceRecordKeyTableName
    ? `AND NOT EXISTS (
        SELECT 1
        FROM ${options.seenSourceRecordKeyTableName} seen_source_record_key
        WHERE seen_source_record_key.source_record_key = app.article_import_route.source_record_key
      )`
    : sourceRecordKeys.length === 0
      ? ''
      : `AND (source_record_key IS NULL OR source_record_key NOT IN (${getQuotedStringList(sourceRecordKeys).join(', ')}))`
  const sourceRecordDeleteKeyClause = options.seenSourceRecordKeyTableName
    ? `AND NOT EXISTS (
        SELECT 1
        FROM ${options.seenSourceRecordKeyTableName} seen_source_record_key
        WHERE seen_source_record_key.source_record_key = app.article_import_route_source_record.source_record_key
      )`
    : sourceRecordKeyClause
  const hasPeriodScope = options.periodStart instanceof Date && options.periodEnd instanceof Date
  const currentLinkPeriodClause = hasPeriodScope
    ? `
      AND app.article_import_route.source_article_created_at >= ${getSqlLiteral(options.periodStart)}
      AND app.article_import_route.source_article_created_at < ${getSqlLiteral(options.periodEnd)}
    `
    : ''
  const sourceRecordPeriodClause = hasPeriodScope
    ? `
      AND source_record.source_article_created_at >= ${getSqlLiteral(options.periodStart)}
      AND source_record.source_article_created_at < ${getSqlLiteral(options.periodEnd)}
    `
    : ''
  const sourceRecordDeletePeriodClause = hasPeriodScope
    ? `
      AND app.article_import_route_source_record.source_article_created_at >= ${getSqlLiteral(options.periodStart)}
      AND app.article_import_route_source_record.source_article_created_at < ${getSqlLiteral(options.periodEnd)}
    `
    : ''
  const deletedRows = await tx.queryJson<DeletedArticleImportRouteLinkRow>(`
    SELECT
      article_id AS articleId,
      external_article_id AS externalArticleId,
      TO_JSON(import_metadata) AS importMetadata,
      import_run_id AS importRunId,
      TO_JSON(match_metadata) AS matchMetadata,
      TO_JSON(raw_payload) AS rawPayload,
      source_article_created_at AS sourceArticleCreatedAt,
      source_kind AS sourceKind,
      source_record_hash AS sourceRecordHash,
      source_record_key AS sourceRecordKey
    FROM app.article_import_route
    WHERE import_route_id = ${getSqlLiteral(importRouteId)}
      ${currentLinkSourceRecordKeyClause}
      ${currentLinkPeriodClause}
  `)
  const deletedSourceRecordRows = await tx.queryJson<DeletedArticleImportRouteLinkRow>(`
    SELECT
      source_record.article_id AS articleId,
      source_record.external_article_id AS externalArticleId,
      TO_JSON(source_record.import_metadata) AS importMetadata,
      source_record.import_run_id AS importRunId,
      TO_JSON(source_record.match_metadata) AS matchMetadata,
      TO_JSON(source_record.raw_payload) AS rawPayload,
      source_record.source_article_created_at AS sourceArticleCreatedAt,
      source_record.source_kind AS sourceKind,
      source_record.source_record_hash AS sourceRecordHash,
      source_record.source_record_key AS sourceRecordKey
    FROM app.article_import_route_source_record source_record
    WHERE source_record.import_route_id = ${getSqlLiteral(importRouteId)}
      AND (source_record.quarantined_at IS NULL OR COALESCE(source_record.quarantine_reason, '') <> 'source_record_remap')
      ${sourceRecordKeyClause}
      ${sourceRecordPeriodClause}
      AND NOT EXISTS (
        SELECT 1
        FROM app.article_import_route current_link
        WHERE current_link.import_route_id = source_record.import_route_id
          AND current_link.source_record_key = source_record.source_record_key
      )
  `)
  const deletedRecords = deletedRows
    .filter((row) => {
      return row.sourceRecordKey !== null && row.sourceRecordHash !== null
    })
    .map((row): DeletedArticleImportRouteLink => {
      return {
        ...row,
        importMetadata: getJsonValue(row.importMetadata),
        importRouteId,
        matchMetadata: getJsonValue(row.matchMetadata),
        rawPayload: getJsonValue(row.rawPayload),
      }
    })
  const deletedCurrentLinkSourceRecordKeys = new Set(
    deletedRecords.map((record) => {
      return record.sourceRecordKey
    }),
  )
  const deletedSourceRecords = deletedSourceRecordRows
    .filter((row) => {
      return !deletedCurrentLinkSourceRecordKeys.has(row.sourceRecordKey)
    })
    .map((row): DeletedArticleImportRouteLink => {
      return {
        ...row,
        importMetadata: getJsonValue(row.importMetadata),
        importRouteId,
        matchMetadata: getJsonValue(row.matchMetadata),
        rawPayload: getJsonValue(row.rawPayload),
      }
    })

  await insertSourceRecordDeletedChangeLogs(tx, [...deletedRecords, ...deletedSourceRecords], options.changeLogContext)

  await tx.run(`
    DELETE FROM app.article_import_route_source_record
    WHERE import_route_id = ${getSqlLiteral(importRouteId)}
      AND (quarantined_at IS NULL OR COALESCE(quarantine_reason, '') <> 'source_record_remap')
      ${sourceRecordDeleteKeyClause}
      ${sourceRecordDeletePeriodClause}
  `)

  await tx.run(`
    DELETE FROM app.article_import_route
    WHERE import_route_id = ${getSqlLiteral(importRouteId)}
      ${currentLinkSourceRecordKeyClause}
      ${currentLinkPeriodClause}
  `)

  await deletedRecords.reduce<Promise<void>>((previousRun, record) => {
    return previousRun.then(async () => {
      await upsertReviewImportArticleHotField(tx, getArticleImportRouteLinkHotFieldInput(record, true))
      await appendImportRouteArticleDelta({
        changeKind: 'importRoute.article.removed',
        record,
        sourceMutationKey: getArticleImportRouteCurrentLinkMutationKey(record),
        sourceOperation: 'delete',
        sourceTable: 'app.article_import_route',
        tombstone: true,
        tx,
      })
    })
  }, Promise.resolve())

  await deletedSourceRecords.reduce<Promise<void>>((previousRun, record) => {
    return previousRun.then(async () => {
      await upsertReviewImportArticleHotField(tx, getArticleImportRouteLinkHotFieldInput(record, true))
      await appendImportRouteArticleDelta({
        changeKind: 'importRoute.article.rankFields.updated',
        record,
        sourceMutationKey: getArticleImportRouteSourceRecordMutationKey(record),
        sourceOperation: 'delete',
        sourceTable: 'app.article_import_route_source_record',
        tombstone: true,
        tx,
      })
    })
  }, Promise.resolve())

  return {deletedRecords, deletedSourceRecords}
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

const syncImportedArticlesForReconciliationPeriodInTx = async (params: {
  changeLogContext?: ReconciliationChangeLogContext | null
  importRoute: string
  periodEnd: Date
  periodStart: Date
  rows: ArticleImportStoreRow[]
  tx: ArticleImportStoreTx
}) => {
  const importRoute = params.importRoute.trim()
  const routes = importRoute === '' ? [] : [importRoute]
  const routeIdMap = await ensureImportRoutes(params.tx, routes)
  const importRouteId = routeIdMap.get(importRoute)
  const incomingRecords =
    importRouteId && params.rows.length > 0
      ? params.rows
          .map((row) => {
            return getScopedArticleImportStoreRow(getNormalizedArticleImportRow(row))
          })
          .filter((row) => {
            return row.importRoute === importRoute
          })
      : []

  if (importRouteId) {
    await insertReconciliationSourceRecordChangeLogs({
      context: params.changeLogContext,
      importRouteId,
      incomingRecords,
      tx: params.tx,
    })
  }

  const importRefreshState =
    params.rows.length > 0
      ? await storeImportedArticlesInTx(params.tx, params.rows, {changeLogContext: params.changeLogContext})
      : {acceptedCount: 0, acceptedSourceRecords: [], importRouteIds: [] as string[]}
  const staleResult = importRouteId
    ? await clearStaleImportRouteLinks(
        params.tx,
        importRouteId,
        getAcceptedImportRouteSourceRecordKeys(importRefreshState.acceptedSourceRecords, importRouteId),
        {changeLogContext: params.changeLogContext, periodEnd: params.periodEnd, periodStart: params.periodStart},
      )
    : {deletedRecords: [], deletedSourceRecords: []}

  return {
    acceptedCount: importRefreshState.acceptedCount,
    deletedSourceRecordCount: staleResult.deletedRecords.length + staleResult.deletedSourceRecords.length,
    importRouteIds:
      importRouteId && !importRefreshState.importRouteIds.includes(importRouteId)
        ? [...importRefreshState.importRouteIds, importRouteId]
        : importRefreshState.importRouteIds,
  }
}

export const storeImportedArticlesWithTx = async (tx: ArticleImportStoreTx, rows: ArticleImportStoreRow[]) => {
  const state = await storeImportedArticlesInTx(tx, rows)

  return {acceptedCount: state.acceptedCount, importRouteIds: state.importRouteIds}
}

export const storeImportedArticlesForReconciliationBatchWithTx = async (params: {
  changeLogContext?: ReconciliationChangeLogContext | null
  importRoute: string
  rows: ArticleImportStoreRow[]
  tx: ArticleImportStoreTx
}) => {
  const importRoute = params.importRoute.trim()
  const routes = importRoute === '' ? [] : [importRoute]
  const routeIdMap = await ensureImportRoutes(params.tx, routes)
  const importRouteId = routeIdMap.get(importRoute)
  const incomingRecords =
    importRouteId && params.rows.length > 0
      ? params.rows
          .map((row) => {
            return getScopedArticleImportStoreRow(getNormalizedArticleImportRow(row))
          })
          .filter((row) => {
            return row.importRoute === importRoute
          })
      : []

  if (importRouteId) {
    await insertReconciliationSourceRecordChangeLogs({
      context: params.changeLogContext,
      importRouteId,
      incomingRecords,
      tx: params.tx,
    })
  }

  const importRefreshState =
    params.rows.length > 0
      ? await storeImportedArticlesInTx(params.tx, params.rows, {changeLogContext: params.changeLogContext})
      : {acceptedCount: 0, acceptedSourceRecords: [], importRouteIds: [] as string[]}

  return {
    acceptedCount: importRefreshState.acceptedCount,
    importRouteIds:
      importRouteId && !importRefreshState.importRouteIds.includes(importRouteId)
        ? [...importRefreshState.importRouteIds, importRouteId]
        : importRefreshState.importRouteIds,
    sourceRecordKeys: importRouteId
      ? getAcceptedImportRouteSourceRecordKeys(importRefreshState.acceptedSourceRecords, importRouteId)
      : [],
  }
}

export const finalizeImportedArticlesForReconciliationPeriodWithTx = async (params: {
  changeLogContext?: ReconciliationChangeLogContext | null
  importRoute: string
  periodEnd: Date
  periodStart: Date
  sourceRecordKeyBatches?: Iterable<string[]>
  sourceRecordKeys: string[]
  tx: ArticleImportStoreTx
}) => {
  const importRoute = params.importRoute.trim()
  const routes = importRoute === '' ? [] : [importRoute]
  const routeIdMap = await ensureImportRoutes(params.tx, routes)
  const importRouteId = routeIdMap.get(importRoute)
  const seenSourceRecordKeyTableName = params.sourceRecordKeyBatches
    ? await createReconciliationSeenSourceRecordKeyTable(
        params.tx,
        params.sourceRecordKeys,
        params.sourceRecordKeyBatches,
      )
    : null
  const staleResult = importRouteId
    ? await clearStaleImportRouteLinks(params.tx, importRouteId, params.sourceRecordKeys, {
        changeLogContext: params.changeLogContext,
        periodEnd: params.periodEnd,
        periodStart: params.periodStart,
        seenSourceRecordKeyTableName,
      })
    : {deletedRecords: [], deletedSourceRecords: []}

  return {
    deletedSourceRecordCount: staleResult.deletedRecords.length + staleResult.deletedSourceRecords.length,
    importRouteIds: importRouteId ? [importRouteId] : [],
  }
}

export const syncImportedArticlesWithTx = async (params: {
  importRoute: string
  rows: ArticleImportStoreRow[]
  tx: ArticleImportStoreTx
}) => {
  return await syncImportedArticlesInTx(params)
}

export const syncImportedArticlesForReconciliationPeriodWithTx = async (params: {
  changeLogContext?: ReconciliationChangeLogContext | null
  importRoute: string
  periodEnd: Date
  periodStart: Date
  rows: ArticleImportStoreRow[]
  tx: ArticleImportStoreTx
}) => {
  return await syncImportedArticlesForReconciliationPeriodInTx(params)
}

export const storeImportedArticles = async (rows: ArticleImportStoreRow[]) => {
  return getAppDatabaseService().transaction(async (tx) => {
    return storeImportedArticlesWithTx(tx, rows)
  }, articleImportStoreWorkloadContext)
}

export type {ArticleImportStoreRow}
