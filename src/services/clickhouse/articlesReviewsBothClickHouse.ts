/**
 * ClickHouse-based articles reviews both query service.
 *
 * Queries articles that have BOTH LLM assessments (in ClickHouse) AND human assessments
 * (in PostgreSQL judgmentsHuman table) for all project prompts.
 *
 * Strategy:
 * 1. Query PostgreSQL for articles fully assessed by humans (judgmentsHuman)
 * 2. Query ClickHouse for LLM judgments on those articles
 * 3. Apply answer filters and pagination
 */
import {and, eq, inArray, sql} from 'drizzle-orm'

import {
  articles,
  importRoute,
  judgmentsHuman,
  projectArticles,
  projectPrompts,
  projectRouteLink,
  projects,
  prompts,
} from '../../db/schema.ts'
import {getDatabase} from '../../server/utils/getDatabase.ts'
import {getJournalTitleFromOriginalData} from '../../utils/getJournalTitleFromOriginalData.ts'
import {getClickhouseClient} from './clickhouseClient.ts'
import {parseClickhouseDateTimeUtc} from './parseClickhouseDateTimeUtc.ts'

/**
 * Input parameters for articles reviews both query
 */
export interface ArticlesReviewsBothParams {
  projectId: string
  page: number
  limit: number
  from?: string | null
  to?: string | null
  search?: string | null
  /** Map of promptId -> array of required LLM answer values */
  prompts?: Record<string, string[]>
}

/**
 * Human answer data per prompt
 */
export interface HumanAnswersByPrompt {
  [promptId: string]: string[]
}

/**
 * ClickHouse judgment row
 */
interface ClickHouseJudgmentRow {
  id: string
  createdAt: string
  articleId: string
  promptId: string
  modelId: string
  answeredOriginal: string | null
  answeredOriginalAsArray: string[]
  explanation: string | null
  quotes: unknown
}

/**
 * Article result with LLM judgments and human answers
 */
export interface ArticleReviewsBothResult {
  id: string
  articleTitle: string | null
  articleCreatedAt: Date | null
  articleUpdatedAt: Date | null
  judgments: ClickHouseJudgmentRow[]
  humanAnswersByPrompt?: HumanAnswersByPrompt
  journalTitle: string | null
}

/**
 * Full response
 */
export interface ArticlesReviewsBothResponse {
  data: ArticleReviewsBothResult[]
  totalCount: number
  page: number
  limit: number
  totalPages: number
}

/**
 * Escapes a string for ClickHouse SQL.
 */
const escapeClickHouseString = (value: string): string => {
  return value.replace(/'/g, "''")
}

const parseQuotesFromClickhouse = (value: unknown): string[] => {
  if (Array.isArray(value)) {
    return value.filter((q): q is string => {
      return typeof q === 'string'
    })
  }

  const raw = typeof value === 'string' ? value.trim() : ''
  const json = raw.startsWith('[') ? raw : ''

  if (!json) return []

  try {
    const parsed = JSON.parse(json) as unknown
    return Array.isArray(parsed)
      ? parsed.filter((q): q is string => {
          return typeof q === 'string'
        })
      : []
  } catch {
    return []
  }
}

/**
 * Formats a Date for ClickHouse DateTime64(3).
 */
const formatDateForClickHouse = (date: Date): string => {
  const year = date.getUTCFullYear()
  const month = String(date.getUTCMonth() + 1).padStart(2, '0')
  const day = String(date.getUTCDate()).padStart(2, '0')
  const hours = String(date.getUTCHours()).padStart(2, '0')
  const minutes = String(date.getUTCMinutes()).padStart(2, '0')
  const seconds = String(date.getUTCSeconds()).padStart(2, '0')
  const millis = String(date.getUTCMilliseconds()).padStart(3, '0')
  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}.${millis}`
}

/**
 * Queries articles reviews both from ClickHouse + PostgreSQL.
 *
 * This is a hybrid query:
 * 1. First finds articles fully assessed by humans (from PostgreSQL judgmentsHuman)
 * 2. Then queries ClickHouse for LLM judgments on those articles
 * 3. Applies answer filters, pagination, and returns combined data
 */
export const queryArticlesReviewsBothFromClickHouse = async (
  params: ArticlesReviewsBothParams,
): Promise<ArticlesReviewsBothResponse> => {
  const startTime = performance.now()
  const db = getDatabase()
  const client = getClickhouseClient()

  // Step 1: Fetch project metadata from PostgreSQL
  console.time('ch:both:metadata')
  const [projectPromptRows, projectBoundsResult, projectImportRouteTexts, curatedArticleRows] = await Promise.all([
    // Get enabled prompts for project
    db
      .select({id: prompts.id, order: projectPrompts.order})
      .from(projectPrompts)
      .innerJoin(prompts, eq(projectPrompts.promptId, prompts.id))
      .where(and(eq(projectPrompts.projectId, params.projectId), eq(projectPrompts.enabled, true)))
      .orderBy(projectPrompts.order),

    // Get project date bounds, modelId, and content settings
    db
      .select({
        dateFrom: projects.dateFrom,
        dateTo: projects.dateTo,
        modelId: projects.modelId,
        useTitle: projects.useTitle,
        useAbstract: projects.useAbstract,
        useFulltext: projects.useFulltext,
        useFulltextNoImages: projects.useFulltextNoImages,
      })
      .from(projects)
      .where(eq(projects.id, params.projectId))
      .limit(1),

    // Get import routes as TEXT
    db
      .select({route: importRoute.route})
      .from(projectRouteLink)
      .innerJoin(importRoute, eq(projectRouteLink.importRouteId, importRoute.id))
      .where(eq(projectRouteLink.projectId, params.projectId)),

    // Get curated article IDs
    db
      .select({articleId: projectArticles.articleId})
      .from(projectArticles)
      .where(eq(projectArticles.projectId, params.projectId)),
  ])
  console.timeEnd('ch:both:metadata')

  const promptIds = projectPromptRows.map((p) => {
    return p.id
  })
  const promptOrderMap = projectPromptRows.reduce(
    (acc, p, idx) => {
      const ord = p.order ?? idx
      return {...acc, [p.id]: ord}
    },
    {} as Record<string, number>,
  )

  if (promptIds.length === 0) {
    return {data: [], totalCount: 0, page: params.page, limit: params.limit, totalPages: 0}
  }

  const projectBounds = projectBoundsResult[0] ?? null
  const modelId = projectBoundsResult[0]?.modelId ?? null
  const useTitle = projectBoundsResult[0]?.useTitle ?? true
  const useAbstract = projectBoundsResult[0]?.useAbstract ?? true
  const useFulltext = projectBoundsResult[0]?.useFulltext ?? false
  const useFulltextNoImages = projectBoundsResult[0]?.useFulltextNoImages ?? false
  const routeTexts = projectImportRouteTexts.map((r) => {
    return r.route
  })
  const curatedArticleIds = curatedArticleRows.map((r) => {
    return r.articleId
  })

  // Step 2: Find articles fully assessed by humans (from PostgreSQL)
  // "Fully assessed" = a single user has answered ALL project prompts for that article
  console.time('ch:both:human_articles')
  const fullyAssessedByHumanQuery = await db
    .select({articleId: judgmentsHuman.articleId})
    .from(judgmentsHuman)
    .where(
      and(
        eq(judgmentsHuman.projectId, params.projectId),
        inArray(judgmentsHuman.promptId, promptIds),
        sql`${judgmentsHuman.answer} IS NOT NULL`,
      ),
    )
    .groupBy(judgmentsHuman.articleId, judgmentsHuman.user)
    .having(sql`COUNT(DISTINCT ${judgmentsHuman.promptId}) = ${promptIds.length}`)

  const humanAssessedArticleIds = [
    ...new Set(
      fullyAssessedByHumanQuery.map((r) => {
        return r.articleId
      }),
    ),
  ]
  console.timeEnd('ch:both:human_articles')
  console.log(`[ClickHouse Both] Found ${humanAssessedArticleIds.length} articles fully assessed by humans`)

  if (humanAssessedArticleIds.length === 0) {
    return {data: [], totalCount: 0, page: params.page, limit: params.limit, totalPages: 0}
  }

  // Step 3: Query ClickHouse for LLM judgments on human-assessed articles
  // Build WHERE conditions
  const whereParts: string[] = []

  // Prompt filter
  const promptIdsQuoted = promptIds
    .map((id) => {
      return `'${id}'`
    })
    .join(', ')
  whereParts.push(`promptId IN (${promptIdsQuoted})`)

  // Model filter
  if (modelId) {
    whereParts.push(`modelId = '${escapeClickHouseString(modelId)}'`)
  }

  // Content settings filters
  whereParts.push(`useTitle = ${useTitle ? 'true' : 'false'}`)
  whereParts.push(`useAbstract = ${useAbstract ? 'true' : 'false'}`)
  whereParts.push(`useFulltext = ${useFulltext ? 'true' : 'false'}`)
  whereParts.push(`useFulltextNoImages = ${useFulltextNoImages ? 'true' : 'false'}`)
  whereParts.push(`deletedAt IS NULL`)

  // Article filter (must be human-assessed)
  const humanArticleIdsQuoted = humanAssessedArticleIds
    .map((id) => {
      return `'${id}'`
    })
    .join(', ')
  whereParts.push(`articleId IN (${humanArticleIdsQuoted})`)

  // Date bounds
  const effectiveFromDate =
    projectBounds?.dateFrom && params.from
      ? projectBounds.dateFrom > new Date(`${params.from}T00:00:00.000Z`)
        ? projectBounds.dateFrom
        : new Date(`${params.from}T00:00:00.000Z`)
      : (projectBounds?.dateFrom ?? (params.from ? new Date(`${params.from}T00:00:00.000Z`) : null))

  const effectiveToDate =
    projectBounds?.dateTo && params.to
      ? projectBounds.dateTo < new Date(`${params.to}T23:59:59.999Z`)
        ? projectBounds.dateTo
        : new Date(`${params.to}T23:59:59.999Z`)
      : (projectBounds?.dateTo ?? (params.to ? new Date(`${params.to}T23:59:59.999Z`) : null))

  if (effectiveFromDate) {
    whereParts.push(`articleCreatedAt >= toDateTime64('${formatDateForClickHouse(effectiveFromDate)}', 3)`)
  }
  if (effectiveToDate) {
    whereParts.push(`articleCreatedAt <= toDateTime64('${formatDateForClickHouse(effectiveToDate)}', 3)`)
  }

  // Search filter
  if (params.search && params.search.trim()) {
    const searchEscaped = escapeClickHouseString(params.search.trim())
    whereParts.push(`articleTitle ILIKE '%${searchEscaped}%'`)
  }

  // Scope filter: curated articles OR import routes
  const scopeParts: string[] = []
  if (curatedArticleIds.length > 0 && curatedArticleIds.length <= 1000) {
    const curatedIdsQuoted = curatedArticleIds
      .map((id) => {
        return `'${id}'`
      })
      .join(', ')
    scopeParts.push(`articleId IN (${curatedIdsQuoted})`)
  }
  if (routeTexts.length > 0) {
    const routesQuoted = routeTexts
      .map((r) => {
        return `'${escapeClickHouseString(r)}'`
      })
      .join(', ')
    scopeParts.push(`articleImportRoute IN (${routesQuoted})`)
  }
  if (scopeParts.length > 0) {
    whereParts.push(`(${scopeParts.join(' OR ')})`)
  }

  // Build HAVING conditions
  const havingParts: string[] = []

  // Article must have ALL prompts answered by LLM
  havingParts.push(`COUNT(DISTINCT promptId) = ${promptIds.length}`)

  // Additional LLM answer filters
  if (params.prompts) {
    for (const [promptId, answeredValues] of Object.entries(params.prompts)) {
      if (!answeredValues || answeredValues.length === 0) continue

      const valuesQuoted = answeredValues
        .map((v) => {
          return `'${escapeClickHouseString(v)}'`
        })
        .join(', ')
      havingParts.push(
        `sumIf(1, promptId = '${promptId}' AND (
          (length(answeredOriginalAsArray) > 0 AND hasAny(arrayMap(x -> assumeNotNull(x), arrayFilter(x -> x IS NOT NULL, answeredOriginalAsArray)), [${valuesQuoted}]))
          OR (length(answeredOriginalAsArray) = 0 AND answeredOriginal IN (${valuesQuoted}))
        )) > 0`,
      )
    }
  }

  const whereClause = whereParts.join(' AND ')
  const havingClause = `HAVING ${havingParts.join(' AND ')}`
  const offset = (params.page - 1) * params.limit

  // Count query
  console.time('ch:both:count')
  const countQuery = `
    SELECT COUNT(*) as totalCount
    FROM (
      SELECT articleId
      FROM judgments
      WHERE ${whereClause}
      GROUP BY articleId
      ${havingClause}
    ) subquery
  `
  const countResult = await client.query({query: countQuery, format: 'JSONEachRow'})
  const countData = await countResult.json<{totalCount: string}>()
  const totalCount = parseInt(countData[0]?.totalCount ?? '0', 10)
  console.timeEnd('ch:both:count')

  if (totalCount === 0) {
    return {data: [], totalCount: 0, page: params.page, limit: params.limit, totalPages: 0}
  }

  // Articles query with pagination
  console.time('ch:both:articles')
  const articlesQuery = `
    SELECT
      articleId,
      any(articleTitle) AS title_,
      max(articleCreatedAt) AS created_,
      max(articleUpdatedAt) AS updated_
    FROM judgments
    WHERE ${whereClause}
    GROUP BY articleId
    ${havingClause}
    ORDER BY created_ DESC NULLS LAST, articleId ASC
    LIMIT ${params.limit}
    OFFSET ${offset}
  `
  const articlesResult = await client.query({query: articlesQuery, format: 'JSONEachRow'})
  const articlesData = await articlesResult.json<{
    articleId: string
    title_: string
    created_: string | null
    updated_: string | null
  }>()
  console.timeEnd('ch:both:articles')
  console.log(`[ClickHouse Both] Found ${articlesData.length} articles with both assessments`)

  if (articlesData.length === 0) {
    return {
      data: [],
      totalCount,
      page: params.page,
      limit: params.limit,
      totalPages: Math.ceil(totalCount / params.limit),
    }
  }

  // Fetch full judgment data for paginated articles
  const articleIds = articlesData.map((a) => {
    return a.articleId
  })
  const articleIdsQuoted = articleIds
    .map((id) => {
      return `'${id}'`
    })
    .join(', ')

  console.time('ch:both:judgments')
  const judgmentsQuery = `
    SELECT
      id,
      createdAt,
      articleId,
      promptId,
      modelId,
      answeredOriginal,
      answeredOriginalAsArray,
      explanation,
      quotes
    FROM judgments
    WHERE articleId IN (${articleIdsQuoted})
      AND promptId IN (${promptIdsQuoted})
      AND deletedAt IS NULL
    ORDER BY articleId, createdAt DESC
  `
  const judgmentsResult = await client.query({query: judgmentsQuery, format: 'JSONEachRow'})
  const judgmentsDataRaw = await judgmentsResult.json<ClickHouseJudgmentRow>()
  const judgmentsData = judgmentsDataRaw.map((j) => {
    return {
      ...j,
      answeredOriginalAsArray: (j.answeredOriginalAsArray ?? []).filter((v): v is string => {
        return typeof v === 'string'
      }),
      quotes: parseQuotesFromClickhouse(j.quotes),
    }
  })
  console.timeEnd('ch:both:judgments')

  // Group judgments by articleId
  const judgmentsByArticle = new Map<string, ClickHouseJudgmentRow[]>()
  for (const j of judgmentsData) {
    const existing = judgmentsByArticle.get(j.articleId) ?? []
    existing.push(j)
    judgmentsByArticle.set(j.articleId, existing)
  }

  // Fetch human answers for these articles from PostgreSQL
  console.time('ch:both:human_answers')
  type HumanRow = {articleId: string; userId: string; promptId: string; answer: string | null; updatedAt: Date | null}

  const humanRows: HumanRow[] = await db
    .select({
      articleId: judgmentsHuman.articleId,
      userId: judgmentsHuman.user,
      promptId: judgmentsHuman.promptId,
      answer: judgmentsHuman.answer,
      updatedAt: judgmentsHuman.updatedAt,
    })
    .from(judgmentsHuman)
    .where(
      and(
        inArray(judgmentsHuman.articleId, articleIds),
        eq(judgmentsHuman.projectId, params.projectId),
        inArray(judgmentsHuman.promptId, promptIds),
        sql`${judgmentsHuman.answer} IS NOT NULL`,
      ),
    )

  // Deduplicate by latest updatedAt for (articleId, userId, promptId)
  const latestByArticleUserPrompt = humanRows.reduce((acc, row) => {
    const key = `${row.articleId}::${row.userId}::${row.promptId}`
    const existing = acc.get(key)
    if (!existing || (row.updatedAt?.getTime() || 0) > (existing.updatedAt?.getTime() || 0)) {
      acc.set(key, row)
    }
    return acc
  }, new Map<string, HumanRow>())

  // Group rows by (articleId, userId) and retain only users who covered ALL prompts
  const rowsByArticleUser = new Map<string, Map<string, HumanRow[]>>()
  for (const row of latestByArticleUserPrompt.values()) {
    const byUser = rowsByArticleUser.get(row.articleId) || new Map<string, HumanRow[]>()
    const arr = byUser.get(row.userId) || []
    arr.push(row)
    byUser.set(row.userId, arr)
    rowsByArticleUser.set(row.articleId, byUser)
  }

  // For each article, collect human answers per prompt from qualifying users
  const humanAnswersByArticlePrompt: Record<string, HumanAnswersByPrompt> = {}
  for (const articleId of articleIds) {
    const byUser = rowsByArticleUser.get(articleId)
    if (!byUser) continue

    const qualifyingUsers: string[] = []
    for (const [userId, rows] of byUser.entries()) {
      const covered = new Set(
        rows.map((r) => {
          return r.promptId
        }),
      )
      if (covered.size === promptIds.length) {
        qualifyingUsers.push(userId)
      }
    }

    if (qualifyingUsers.length === 0) continue

    const promptMap: HumanAnswersByPrompt = {}
    for (const pid of promptIds) promptMap[pid] = []

    for (const userId of qualifyingUsers) {
      const rows = byUser.get(userId) || []
      for (const r of rows) {
        if (r.answer !== null && r.answer !== undefined) {
          const bucket = promptMap[r.promptId]
          if (bucket) bucket.push(r.answer)
        }
      }
    }

    humanAnswersByArticlePrompt[articleId] = promptMap
  }
  console.timeEnd('ch:both:human_answers')

  const articleOriginalDataRows = await db
    .select({id: articles.id, originalData: articles.originalData})
    .from(articles)
    .where(inArray(articles.id, articleIds))

  const journalTitlesByArticleId = articleOriginalDataRows.reduce(
    (acc, row) => {
      return {...acc, [row.id]: getJournalTitleFromOriginalData(row.originalData)}
    },
    {} as Record<string, string | null>,
  )

  // Build final results
  const results: ArticleReviewsBothResult[] = articlesData.map((article) => {
    const judgments = judgmentsByArticle.get(article.articleId) ?? []

    // Sort judgments by prompt order
    const sortedJudgments = [...judgments].sort((a, b) => {
      const ao = promptOrderMap[a.promptId] ?? Number.MAX_SAFE_INTEGER
      const bo = promptOrderMap[b.promptId] ?? Number.MAX_SAFE_INTEGER
      return ao - bo
    })

    return {
      id: article.articleId,
      articleTitle: article.title_,
      articleCreatedAt: parseClickhouseDateTimeUtc(article.created_),
      articleUpdatedAt: parseClickhouseDateTimeUtc(article.updated_),
      judgments: sortedJudgments,
      humanAnswersByPrompt: humanAnswersByArticlePrompt[article.articleId],
      journalTitle: journalTitlesByArticleId[article.articleId] ?? null,
    }
  })

  const elapsed = performance.now() - startTime
  console.log(`[ClickHouse Both] Total query time: ${elapsed.toFixed(0)}ms`)

  return {
    data: results,
    totalCount,
    page: params.page,
    limit: params.limit,
    totalPages: Math.ceil(totalCount / params.limit),
  }
}
