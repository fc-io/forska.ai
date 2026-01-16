/**
 * ClickHouse-based unassessed articles queries.
 *
 * Replaces PostgreSQL queries for:
 * - Jobs page: unassessed count
 * - Reviews/unassessed page: paginated list
 * - Cron queue fill: (article, prompt) pairs
 *
 * Uses:
 * - `pg.*` tables for MaterializedPostgreSQL replicas (judgments, project_*, etc.)
 * - `forska.articles` MergeTree table (100% synced, workaround for MaterializedPG bug)
 *
 * Key differences from PostgreSQL:
 * - No NOT EXISTS - use LEFT JOIN + IS NULL
 * - No JOIN ON constant - use CTE + CROSS JOIN
 * - 0-prompt guard: return early if no enabled prompts
 */
import {and, eq} from 'drizzle-orm'

import {projectPrompts, projectRouteLink, projects} from '../../db/schema.ts'
import {getDatabase} from '../../server/utils/getDatabase.ts'
import {getClickhouseClient} from './clickhouseClient.ts'

type ProjectMetadata = {
  id: string
  modelId: string
  dateFrom: Date | null
  dateTo: Date | null
  useTitle: boolean
  useAbstract: boolean
  useFulltext: boolean
  useFulltextNoImages: boolean
}

type UnassessedCountParams = {
  projectId: string
  projectModelId: string
  projectDateFrom: Date | null | undefined
  projectDateTo: Date | null | undefined
  importRouteIds: string[]
  useTitle: boolean
  useAbstract: boolean
  useFulltext: boolean
  useFulltextNoImages: boolean
}

type UnassessedArticlesParams = UnassessedCountParams & {limit: number; offset: number; search?: string}

type UnassessedPairsParams = {projectId: string; jobId: string; numberOfPromptsToGet: number}

type UnassessedArticleRow = {
  id: string
  articleId: string | null
  articleTitle: string
  articleCreatedAt: Date | null
  articleUpdatedAt: Date | null
}

type PromptQueueEntry = {articleId: string; promptId: string}

const escapeClickHouseString = (value: string): string => {
  return value.replace(/'/g, "''").replace(/\\/g, '\\\\')
}

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

const fetchEnabledPromptIds = async (projectId: string): Promise<string[]> => {
  const db = getDatabase()
  const rows = await db
    .select({promptId: projectPrompts.promptId})
    .from(projectPrompts)
    .where(
      and(
        eq(projectPrompts.projectId, projectId),
        eq(projectPrompts.enabled, true),
        eq(projectPrompts.archived, false),
      ),
    )
  return rows.map((r) => {
    return r.promptId
  })
}

const fetchProjectMetadata = async (projectId: string): Promise<ProjectMetadata | null> => {
  const db = getDatabase()
  const [row] = await db
    .select({
      id: projects.id,
      modelId: projects.modelId,
      dateFrom: projects.dateFrom,
      dateTo: projects.dateTo,
      useTitle: projects.useTitle,
      useAbstract: projects.useAbstract,
      useFulltext: projects.useFulltext,
      useFulltextNoImages: projects.useFulltextNoImages,
    })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1)

  return row
    ? {
        id: row.id,
        modelId: row.modelId,
        dateFrom: row.dateFrom,
        dateTo: row.dateTo,
        useTitle: row.useTitle ?? true,
        useAbstract: row.useAbstract ?? true,
        useFulltext: row.useFulltext ?? false,
        useFulltextNoImages: row.useFulltextNoImages ?? false,
      }
    : null
}

const fetchImportRouteIds = async (projectId: string): Promise<string[]> => {
  const db = getDatabase()
  const rows = await db
    .select({importRouteId: projectRouteLink.importRouteId})
    .from(projectRouteLink)
    .where(eq(projectRouteLink.projectId, projectId))
  return rows.map((r) => {
    return r.importRouteId
  })
}

const buildScopedArticlesCTE = (projectId: string, importRouteIds: string[]): string => {
  const projectIdEscaped = escapeClickHouseString(projectId)

  const projectArticlesPart = `
    SELECT article_id FROM pg.project_articles WHERE project_id = '${projectIdEscaped}'`

  const importRoutesPart =
    importRouteIds.length > 0
      ? `
    UNION DISTINCT
    SELECT arl.article_id
    FROM pg.project_route_link prl
    INNER JOIN pg.article_route_link arl ON arl.import_route_id = prl.import_route_id
    WHERE prl.project_id = '${projectIdEscaped}'`
      : ''

  return `scoped AS (${projectArticlesPart}${importRoutesPart})`
}

const buildDateConditions = (dateFrom: Date | null | undefined, dateTo: Date | null | undefined): string[] => {
  const conditions: string[] = []
  if (dateFrom) {
    conditions.push(`a.article_created_at >= toDateTime64('${formatDateForClickHouse(dateFrom)}', 3)`)
  }
  if (dateTo) {
    conditions.push(`a.article_created_at <= toDateTime64('${formatDateForClickHouse(dateTo)}', 3)`)
  }
  return conditions
}

/**
 * Count unassessed articles for a project using ClickHouse.
 *
 * Strategy:
 * 1. Build scoped articles (project_articles UNION article_route_link)
 * 2. Build assessed articles (fully judged for all enabled prompts)
 * 3. Return: scoped - assessed (using LEFT JOIN + IS NULL)
 *
 * 0-prompt guard: Returns 0 if no enabled prompts
 */
export const getUnassessedCountFromClickHouse = async (params: UnassessedCountParams): Promise<number> => {
  const client = getClickhouseClient()
  const {
    projectId,
    projectModelId,
    projectDateFrom,
    projectDateTo,
    importRouteIds,
    useTitle,
    useAbstract,
    useFulltext,
    useFulltextNoImages,
  } = params

  console.time('ch:unassessed_count')

  const promptIds = await fetchEnabledPromptIds(projectId)

  if (promptIds.length === 0) {
    console.timeEnd('ch:unassessed_count')
    console.log('[CH] 0 enabled prompts - returning 0')
    return 0
  }

  const modelIdEscaped = escapeClickHouseString(projectModelId)
  const dateConditions = buildDateConditions(projectDateFrom, projectDateTo)
  const dateConditionsStr = dateConditions.length > 0 ? ` AND ${dateConditions.join(' AND ')}` : ''

  const query = `
    WITH
      ${buildScopedArticlesCTE(projectId, importRouteIds)},
      enabled_prompts AS (
        SELECT prompt_id FROM pg.project_prompts
        WHERE project_id = '${escapeClickHouseString(projectId)}'
          AND enabled = true
          AND archived = false
      ),
      assessed AS (
        SELECT j.article_id
        FROM pg.judgments j
        WHERE j.article_id IN (SELECT article_id FROM scoped)
          AND j.deleted_at IS NULL
          AND j.is_answered = true
          AND j.model_id = '${modelIdEscaped}'
          AND j.use_title = ${useTitle}
          AND j.use_abstract = ${useAbstract}
          AND j.use_fulltext = ${useFulltext}
          AND j.use_fulltext_no_images = ${useFulltextNoImages}
          AND j.prompt_id IN (SELECT prompt_id FROM enabled_prompts)
        GROUP BY j.article_id
        HAVING countDistinct(j.prompt_id) >= (SELECT COUNT(*) FROM enabled_prompts)
      )
    SELECT COUNT(*) as unassessed_count
    FROM scoped s
    INNER JOIN forska.articles a ON s.article_id = a.id
    WHERE s.article_id NOT IN (SELECT article_id FROM assessed)${dateConditionsStr}
  `

  console.log('[CH] Unassessed count query:', query.substring(0, 300) + '...')

  const result = await client.query({query, format: 'JSONEachRow'})
  const data = await result.json<{unassessed_count: string}>()

  console.timeEnd('ch:unassessed_count')

  const count = parseInt(data[0]?.unassessed_count ?? '0', 10)
  console.log(`[CH] Unassessed count: ${count}`)
  return count
}

/**
 * Get paginated unassessed articles list using ClickHouse.
 *
 * Returns article IDs + metadata sorted by article_updated_at DESC.
 * Uses keyset pagination is recommended for production but this uses OFFSET for compatibility.
 *
 * 0-prompt guard: Returns empty array if no enabled prompts
 */
export const getUnassessedArticlesFromClickHouse = async (
  params: UnassessedArticlesParams,
): Promise<{articles: UnassessedArticleRow[]; totalCount: number}> => {
  const client = getClickhouseClient()
  const {
    projectId,
    projectModelId,
    projectDateFrom,
    projectDateTo,
    importRouteIds,
    useTitle,
    useAbstract,
    useFulltext,
    useFulltextNoImages,
    limit,
    offset,
    search,
  } = params

  console.time('ch:unassessed_articles')
  console.log('[CH] Params:', {
    projectId,
    projectModelId,
    dateFrom: projectDateFrom?.toISOString(),
    dateTo: projectDateTo?.toISOString(),
    importRouteIds: importRouteIds.length,
    useTitle,
    useAbstract,
    useFulltext,
    useFulltextNoImages,
  })

  const promptIds = await fetchEnabledPromptIds(projectId)
  console.log(`[CH] Enabled prompts: ${promptIds.length}`, promptIds)

  if (promptIds.length === 0) {
    console.timeEnd('ch:unassessed_articles')
    console.log('[CH] 0 enabled prompts - returning empty')
    return {articles: [], totalCount: 0}
  }

  const modelIdEscaped = escapeClickHouseString(projectModelId)
  const dateConditions = buildDateConditions(projectDateFrom, projectDateTo)
  const searchCondition = search?.trim()
    ? ` AND a.article_title ILIKE '%${escapeClickHouseString(search.trim())}%'`
    : ''
  const dateConditionsStr = dateConditions.length > 0 ? ` AND ${dateConditions.join(' AND ')}` : ''

  const withClauses = `
    WITH
      ${buildScopedArticlesCTE(projectId, importRouteIds)},
      enabled_prompts AS (
        SELECT prompt_id FROM pg.project_prompts
        WHERE project_id = '${escapeClickHouseString(projectId)}'
          AND enabled = true
          AND archived = false
      ),
      assessed AS (
        SELECT j.article_id
        FROM pg.judgments j
        WHERE j.article_id IN (SELECT article_id FROM scoped)
          AND j.deleted_at IS NULL
          AND j.is_answered = true
          AND j.model_id = '${modelIdEscaped}'
          AND j.use_title = ${useTitle}
          AND j.use_abstract = ${useAbstract}
          AND j.use_fulltext = ${useFulltext}
          AND j.use_fulltext_no_images = ${useFulltextNoImages}
          AND j.prompt_id IN (SELECT prompt_id FROM enabled_prompts)
        GROUP BY j.article_id
        HAVING countDistinct(j.prompt_id) >= (SELECT COUNT(*) FROM enabled_prompts)
      ),
      unassessed AS (
        SELECT s.article_id AS article_id
        FROM scoped s
        INNER JOIN forska.articles a ON s.article_id = a.id
        WHERE s.article_id NOT IN (SELECT article_id FROM assessed)${dateConditionsStr}${searchCondition}
      )`

  const countQuery = `
    ${withClauses}
    SELECT COUNT(*) as total_count FROM unassessed
  `

  const articlesQuery = `
    ${withClauses}
    SELECT
      a.id,
      a.article_id,
      a.article_title,
      a.article_created_at,
      a.article_updated_at
    FROM unassessed u
    INNER JOIN forska.articles a ON u.article_id = a.id
    ORDER BY COALESCE(a.article_updated_at, a.article_created_at, a.created_at) DESC, a.id DESC
    LIMIT ${limit}
    OFFSET ${offset}
  `

  console.log('[CH] Unassessed articles query:', articlesQuery.substring(0, 300) + '...')

  const diagnosticQuery = `
    WITH
      ${buildScopedArticlesCTE(projectId, importRouteIds)},
      enabled_prompts AS (
        SELECT prompt_id FROM pg.project_prompts
        WHERE project_id = '${escapeClickHouseString(projectId)}'
          AND enabled = true
          AND archived = false
      ),
      assessed AS (
        SELECT j.article_id
        FROM pg.judgments j
        WHERE j.article_id IN (SELECT article_id FROM scoped)
          AND j.deleted_at IS NULL
          AND j.is_answered = true
          AND j.model_id = '${modelIdEscaped}'
          AND j.use_title = ${useTitle}
          AND j.use_abstract = ${useAbstract}
          AND j.use_fulltext = ${useFulltext}
          AND j.use_fulltext_no_images = ${useFulltextNoImages}
          AND j.prompt_id IN (SELECT prompt_id FROM enabled_prompts)
        GROUP BY j.article_id
        HAVING countDistinct(j.prompt_id) >= (SELECT COUNT(*) FROM enabled_prompts)
      ),
      unassessed_no_date AS (
        SELECT s.article_id
        FROM scoped s
        INNER JOIN forska.articles a ON s.article_id = a.id
        WHERE s.article_id NOT IN (SELECT article_id FROM assessed)
      ),
      unassessed_with_date AS (
        SELECT s.article_id
        FROM scoped s
        INNER JOIN forska.articles a ON s.article_id = a.id
        WHERE s.article_id NOT IN (SELECT article_id FROM assessed)${dateConditionsStr}
      )
    SELECT
      (SELECT COUNT(*) FROM scoped) as scoped_count,
      (SELECT COUNT(*) FROM enabled_prompts) as enabled_prompts_count,
      (SELECT COUNT(*) FROM assessed) as assessed_count,
      (SELECT COUNT(*) FROM unassessed_no_date) as unassessed_no_date_count,
      (SELECT COUNT(*) FROM unassessed_with_date) as unassessed_with_date_count
  `

  const scopedSampleQuery = `
    WITH ${buildScopedArticlesCTE(projectId, importRouteIds)}
    SELECT
      article_id,
      toTypeName(article_id) as article_id_type
    FROM scoped
    LIMIT 3
  `

  const articlesSampleQuery = `
    SELECT
      id,
      toTypeName(id) as id_type
    FROM forska.articles
    LIMIT 3
  `

  const joinTestQuery = `
    WITH ${buildScopedArticlesCTE(projectId, importRouteIds)}
    SELECT COUNT(*) as joined_count
    FROM scoped s
    INNER JOIN forska.articles a ON toString(s.article_id) = toString(a.id)
  `

  const dateFilterTestQuery = `
    WITH ${buildScopedArticlesCTE(projectId, importRouteIds)}
    SELECT
      COUNT(*) as total_scoped,
      countIf(a.article_created_at IS NULL) as null_dates,
      countIf(a.article_created_at IS NOT NULL) as has_dates,
      countIf(a.article_created_at >= toDateTime64('${projectDateFrom ? formatDateForClickHouse(projectDateFrom) : '1970-01-01 00:00:00.000'}', 3)
        AND a.article_created_at <= toDateTime64('${projectDateTo ? formatDateForClickHouse(projectDateTo) : '2099-12-31 23:59:59.999'}', 3)) as matches_date_filter,
      min(a.article_created_at) as min_date,
      max(a.article_created_at) as max_date
    FROM scoped s
    INNER JOIN forska.articles a ON s.article_id = a.id
  `

  const [
    countResult,
    articlesResult,
    diagnosticResult,
    scopedSampleResult,
    articlesSampleResult,
    joinTestResult,
    dateFilterTestResult,
  ] = await Promise.all([
    client.query({query: countQuery, format: 'JSONEachRow'}),
    client.query({query: articlesQuery, format: 'JSONEachRow'}),
    client.query({query: diagnosticQuery, format: 'JSONEachRow'}),
    client.query({query: scopedSampleQuery, format: 'JSONEachRow'}).catch((e) => {
      console.log('[CH] Scoped sample query failed:', e.message)
      return null
    }),
    client.query({query: articlesSampleQuery, format: 'JSONEachRow'}).catch((e) => {
      console.log('[CH] Articles sample query failed:', e.message)
      return null
    }),
    client.query({query: joinTestQuery, format: 'JSONEachRow'}).catch((e) => {
      console.log('[CH] Join test query failed:', e.message)
      return null
    }),
    client.query({query: dateFilterTestQuery, format: 'JSONEachRow'}).catch((e) => {
      console.log('[CH] Date filter test query failed:', e.message)
      return null
    }),
  ])

  const diagnosticData = await diagnosticResult.json<{
    scoped_count: string
    enabled_prompts_count: string
    assessed_count: string
    unassessed_no_date_count: string
    unassessed_with_date_count: string
  }>()
  console.log('[CH] Diagnostic counts:', diagnosticData[0])

  if (scopedSampleResult) {
    const scopedSample = await scopedSampleResult.json()
    console.log('[CH] Scoped sample (type check):', scopedSample)
  }

  if (articlesSampleResult) {
    const articlesSample = await articlesSampleResult.json()
    console.log('[CH] Articles sample (type check):', articlesSample)
  }

  if (joinTestResult) {
    const joinTest = await joinTestResult.json<{joined_count: string}>()
    console.log('[CH] Join test with toString():', joinTest[0])
  }

  if (dateFilterTestResult) {
    const dateFilterTest = await dateFilterTestResult.json()
    console.log('[CH] Date filter test:', dateFilterTest[0])
  }

  const assessedOverlapQuery = `
    WITH
      ${buildScopedArticlesCTE(projectId, importRouteIds)},
      enabled_prompts AS (
        SELECT prompt_id FROM pg.project_prompts
        WHERE project_id = '${escapeClickHouseString(projectId)}'
          AND enabled = true AND archived = false
      ),
      assessed AS (
        SELECT j.article_id
        FROM pg.judgments j
        WHERE j.article_id IN (SELECT article_id FROM scoped)
          AND j.deleted_at IS NULL AND j.is_answered = true
          AND j.model_id = '${modelIdEscaped}'
          AND j.use_title = ${useTitle} AND j.use_abstract = ${useAbstract}
          AND j.use_fulltext = ${useFulltext} AND j.use_fulltext_no_images = ${useFulltextNoImages}
          AND j.prompt_id IN (SELECT prompt_id FROM enabled_prompts)
        GROUP BY j.article_id
        HAVING countDistinct(j.prompt_id) >= (SELECT COUNT(*) FROM enabled_prompts)
      ),
      joined_test AS (
        SELECT s.article_id as scoped_id, a.id as forska_id
        FROM scoped s
        INNER JOIN forska.articles a ON s.article_id = a.id
        LIMIT 5
      ),
      assessed_in_forska AS (
        SELECT COUNT(*) as cnt
        FROM assessed ass
        INNER JOIN forska.articles a ON ass.article_id = a.id
      )
    SELECT
      (SELECT COUNT(*) FROM joined_test) as join_sample_count,
      (SELECT cnt FROM assessed_in_forska) as assessed_in_forska_count,
      (SELECT any(scoped_id) FROM joined_test) as sample_scoped_id,
      (SELECT any(forska_id) FROM joined_test) as sample_forska_id
  `

  try {
    const assessedOverlapResult = await client.query({query: assessedOverlapQuery, format: 'JSONEachRow'})
    const assessedOverlap = await assessedOverlapResult.json()
    console.log('[CH] Assessed overlap test:', assessedOverlap[0])
  } catch (e: unknown) {
    console.log('[CH] Assessed overlap query failed:', (e as Error).message?.substring(0, 200))
  }

  const countData = await countResult.json<{total_count: string}>()
  const articlesData = await articlesResult.json<{
    id: string
    article_id: string | null
    article_title: string
    article_created_at: string | null
    article_updated_at: string | null
  }>()

  console.timeEnd('ch:unassessed_articles')

  const totalCount = parseInt(countData[0]?.total_count ?? '0', 10)
  const articles: UnassessedArticleRow[] = articlesData.map((row) => {
    return {
      id: row.id,
      articleId: row.article_id,
      articleTitle: row.article_title,
      articleCreatedAt: row.article_created_at ? new Date(row.article_created_at) : null,
      articleUpdatedAt: row.article_updated_at ? new Date(row.article_updated_at) : null,
    }
  })

  console.log(`[CH] Found ${articles.length} unassessed articles (total: ${totalCount})`)
  return {articles, totalCount}
}

/**
 * Get (article, prompt) pairs that need to be judged for cron queue fill.
 *
 * Returns pairs where:
 * - Article is in project scope
 * - Article+prompt pair not already in judgments_jobs_prompts for this job
 * - Article+prompt pair not already judged with matching model/content settings
 *
 * 0-prompt guard: Returns empty array if no enabled prompts
 *
 * Note: Does NOT check judgments_jobs_prompts (PostgreSQL table) - that must be done
 * separately in application code with onConflictDoNothing.
 */
export const getUnassessedPairsFromClickHouse = async (
  params: UnassessedPairsParams,
): Promise<{promptEntries: PromptQueueEntry[]}> => {
  const {projectId, numberOfPromptsToGet} = params
  const client = getClickhouseClient()

  console.time('ch:unassessed_pairs')

  const [project, promptIds, importRouteIds] = await Promise.all([
    fetchProjectMetadata(projectId),
    fetchEnabledPromptIds(projectId),
    fetchImportRouteIds(projectId),
  ])

  if (!project) {
    console.timeEnd('ch:unassessed_pairs')
    console.log('[CH] Project not found - returning empty')
    return {promptEntries: []}
  }

  if (promptIds.length === 0) {
    console.timeEnd('ch:unassessed_pairs')
    console.log('[CH] 0 enabled prompts - returning empty')
    return {promptEntries: []}
  }

  const modelIdEscaped = escapeClickHouseString(project.modelId)
  const dateConditions = buildDateConditions(project.dateFrom, project.dateTo)
  const dateConditionsStr = dateConditions.length > 0 ? ` AND ${dateConditions.join(' AND ')}` : ''

  const query = `
    WITH
      ${buildScopedArticlesCTE(projectId, importRouteIds)},
      enabled_prompts AS (
        SELECT prompt_id FROM pg.project_prompts
        WHERE project_id = '${escapeClickHouseString(projectId)}'
          AND enabled = true
          AND archived = false
      ),
      assessed_pairs AS (
        SELECT j.article_id, j.prompt_id
        FROM pg.judgments j
        WHERE j.article_id IN (SELECT article_id FROM scoped)
          AND j.deleted_at IS NULL
          AND j.is_answered = true
          AND j.model_id = '${modelIdEscaped}'
          AND j.use_title = ${project.useTitle}
          AND j.use_abstract = ${project.useAbstract}
          AND j.use_fulltext = ${project.useFulltext}
          AND j.use_fulltext_no_images = ${project.useFulltextNoImages}
          AND j.prompt_id IN (SELECT prompt_id FROM enabled_prompts)
      ),
      scoped_with_dates AS (
        SELECT s.article_id, a.article_updated_at, a.article_created_at, a.created_at
        FROM scoped s
        INNER JOIN forska.articles a ON s.article_id = a.id
        WHERE 1=1${dateConditionsStr}
      )
    SELECT s.article_id, ep.prompt_id
    FROM scoped_with_dates s
    CROSS JOIN enabled_prompts ep
    LEFT JOIN assessed_pairs ap ON ap.article_id = s.article_id AND ap.prompt_id = ep.prompt_id
    WHERE ap.article_id IS NULL
    ORDER BY COALESCE(s.article_updated_at, s.article_created_at, s.created_at) DESC, s.article_id DESC
    LIMIT ${numberOfPromptsToGet}
  `

  console.log('[CH] Unassessed pairs query:', query.substring(0, 300) + '...')

  const result = await client.query({query, format: 'JSONEachRow'})
  const data = await result.json<{article_id: string; prompt_id: string}>()

  console.timeEnd('ch:unassessed_pairs')

  const promptEntries: PromptQueueEntry[] = data.map((row) => {
    return {articleId: row.article_id, promptId: row.prompt_id}
  })

  console.log(`[CH] Found ${promptEntries.length} unassessed pairs`)
  return {promptEntries}
}
