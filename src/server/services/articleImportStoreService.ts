import {getArticleSourceMetadata, getOriginalDoi, normalizeDoi} from '../../utils/articleSourceMetadata.ts'
import {getAppDatabaseService} from './appDatabaseService.ts'
import {getQuotedStringList, getSqlLiteral} from './appQueryHelpers.ts'
import {getProjectMartRefreshStateService} from './projectMartRefreshStateService.ts'

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
] as const satisfies readonly PersistedArticleKey[]

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
  if (articleIds.length === 0) {
    return new Set<string>()
  }

  const rows = await tx.queryJson<{articleId: string}>(`
    SELECT article_id AS articleId
    FROM app.article
    WHERE article_id IN (${getQuotedStringList(articleIds).join(', ')})
  `)

  return new Set(
    rows.map((row) => {
      return row.articleId
    }),
  )
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

  await params.tx.run(`
    INSERT INTO app.article (${columnNames.join(', ')})
    VALUES ${getArticleValues({includedKeys: params.includedKeys, includeInternalId: true, rows: params.rows})}
    ON CONFLICT(article_id) DO NOTHING
  `)
}

const storeImportedArticlesInTx = async (tx: ArticleImportStoreTx, rows: ArticleImportStoreRow[]) => {
  if (rows.length === 0) {
    return {importRouteIds: [] as string[]}
  }

  const normalizedRows = Array.from(
    rows
      .reduce<Map<string, ArticleImportStoreRow>>((acc, row) => {
        const normalizedRow = getNormalizedArticleImportRow(row)
        acc.set(normalizedRow.articleId, normalizedRow)
        return acc
      }, new Map())
      .values(),
  )
  const includedKeys = getIncludedArticleKeys(normalizedRows)
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
  const existingArticleIds = await getExistingArticleIds(
    tx,
    normalizedRows.map((row) => {
      return row.articleId
    }),
  )
  const rowsToInsert = normalizedRows.filter((row) => {
    return !existingArticleIds.has(row.articleId)
  })

  await insertImportedArticlesInTx({includedKeys, rows: rowsToInsert, tx})

  const upsertedArticles = await tx.queryJson<{id: string; articleId: string}>(`
    SELECT id, article_id AS articleId
    FROM app.article
    WHERE article_id IN (${getQuotedStringList(
      normalizedRows.map((row) => {
        return row.articleId
      }),
    ).join(', ')})
  `)

  const routeIdMap = await ensureImportRoutes(tx, routes)
  const articleIdToRoute = new Map(
    normalizedRows.map((row) => {
      return [row.articleId, row.importRoute]
    }),
  )
  const linkValues = upsertedArticles
    .map((article) => {
      const route = articleIdToRoute.get(article.articleId)
      const importRouteId = route ? routeIdMap.get(route) : null
      return importRouteId
        ? `(${getQuotedStringList([crypto.randomUUID(), article.id, importRouteId]).join(', ')})`
        : null
    })
    .filter((value): value is string => {
      return value !== null
    })

  if (linkValues.length > 0) {
    await tx.run(`
      INSERT INTO app.article_import_route (id, article_id, import_route_id)
      VALUES ${linkValues.join(', ')}
      ON CONFLICT(article_id, import_route_id) DO NOTHING
    `)
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

export const queueImportedArticleRefreshes = async (importRouteIds: string[]) => {
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
    const refreshStateService = getProjectMartRefreshStateService()
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

  await queueImportedArticleRefreshes(importRefreshState.importRouteIds)
}

export type {ArticleImportStoreRow}
