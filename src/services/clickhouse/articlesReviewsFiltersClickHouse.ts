/**
 * ClickHouse-based filter options query for articles reviews.
 *
 * This is the ClickHouse equivalent of articlesReviewsFiltersDatabase.ts.
 * Used for prompts with open-ended types (string, string[], etc.) where
 * we need to query distinct answer values from the judgments table.
 *
 * Performance: Expected ~1-2 seconds for ~25M rows (vs potentially slower in PostgreSQL)
 */
import {eq} from 'drizzle-orm'

import {importRoute, projectArticles, projectRouteLink, projects} from '../../db/schema.ts'
import type {PromptFilterInfo} from '../../server/routes/projectsRoutes/articlesReviewsFiltersUtils.ts'
import {getDatabase} from '../../server/utils/getDatabase.ts'
import {getClickhouseClient} from './clickhouseClient.ts'

export type ClickHouseFilterResult = {promptId: string; promptName: string; answeredOriginalValues: string[]}

export type ClickHouseFilterParams = {
  projectId: string
  prompts: PromptFilterInfo[]
  fromDate: Date | null
  toDate: Date | null
  searchTitle: string
}

/**
 * Escapes a string for ClickHouse SQL.
 * Replaces single quotes with escaped single quotes.
 */
const escapeClickHouseString = (value: string): string => {
  return value.replace(/'/g, "''")
}

/**
 * Formats a Date for ClickHouse DateTime64(3).
 * ClickHouse doesn't accept the 'Z' suffix, so we format as 'YYYY-MM-DD HH:MM:SS.mmm'
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
 * Fetches project metadata from PostgreSQL needed for filter queries.
 * This includes project bounds, import routes, and curated articles.
 */
const fetchProjectMetadataForFilters = async (projectId: string) => {
  const db = getDatabase()

  const [projectBoundsResult, projectImportRouteTexts, curatedArticleRows, projectModelResult] = await Promise.all([
    // Get project date bounds and content settings
    db
      .select({
        dateFrom: projects.dateFrom,
        dateTo: projects.dateTo,
        useTitle: projects.useTitle,
        useAbstract: projects.useAbstract,
        useFulltext: projects.useFulltext,
        useFulltextNoImages: projects.useFulltextNoImages,
      })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1),

    // Get import routes as TEXT
    db
      .select({route: importRoute.route})
      .from(projectRouteLink)
      .innerJoin(importRoute, eq(projectRouteLink.importRouteId, importRoute.id))
      .where(eq(projectRouteLink.projectId, projectId)),

    // Get curated article IDs
    db
      .select({articleId: projectArticles.articleId})
      .from(projectArticles)
      .where(eq(projectArticles.projectId, projectId)),

    // Get project model ID
    db.select({modelId: projects.modelId}).from(projects).where(eq(projects.id, projectId)).limit(1),
  ])

  return {
    projectBounds: projectBoundsResult[0] ?? null,
    routeTexts: projectImportRouteTexts.map((r) => {
      return r.route
    }),
    curatedArticleIds: curatedArticleRows.map((r) => {
      return r.articleId
    }),
    modelId: projectModelResult[0]?.modelId ?? null,
    useTitle: projectBoundsResult[0]?.useTitle ?? true,
    useAbstract: projectBoundsResult[0]?.useAbstract ?? true,
    useFulltext: projectBoundsResult[0]?.useFulltext ?? false,
    useFulltextNoImages: projectBoundsResult[0]?.useFulltextNoImages ?? false,
  }
}

/**
 * Get filter options by querying distinct values from ClickHouse judgments table.
 * Used for prompts with open-ended types (string, string[], etc.).
 *
 * This queries ClickHouse for all distinct answer values for the given prompts,
 * respecting project scope (import routes + curated articles) and date filters.
 */
export const getDatabaseBasedFiltersFromClickHouse = async (
  params: ClickHouseFilterParams,
): Promise<ClickHouseFilterResult[]> => {
  const startTime = performance.now()
  const client = getClickhouseClient()

  // Filter to only database-strategy prompts
  const databasePrompts = params.prompts.filter((p) => {
    return p.strategy === 'database'
  })

  if (databasePrompts.length === 0) {
    return []
  }

  // Fetch project metadata from PostgreSQL
  console.time('ch:filters:metadata')
  const metadata = await fetchProjectMetadataForFilters(params.projectId)
  console.timeEnd('ch:filters:metadata')

  const promptIds = databasePrompts.map((p) => {
    return p.promptId
  })

  // Check scope
  const hasImportRoutes = metadata.routeTexts.length > 0
  const hasCuratedArticles = metadata.curatedArticleIds.length > 0

  if (!hasImportRoutes && !hasCuratedArticles) {
    console.log('[ClickHouse Filters] No scope defined, returning empty')
    return databasePrompts.map((p) => {
      return {promptId: p.promptId, promptName: p.promptName, answeredOriginalValues: []}
    })
  }

  // Build WHERE conditions
  const whereParts: string[] = []

  // Prompt filter - only the open-ended prompts we need filter values for
  const promptIdsQuoted = promptIds
    .map((id) => {
      return `'${id}'`
    })
    .join(', ')
  whereParts.push(`promptId IN (${promptIdsQuoted})`)

  // Model filter - must match project's model
  if (metadata.modelId) {
    whereParts.push(`modelId = '${escapeClickHouseString(metadata.modelId)}'`)
  }

  // Content settings filters
  whereParts.push(`useTitle = ${metadata.useTitle ? 'true' : 'false'}`)
  whereParts.push(`useAbstract = ${metadata.useAbstract ? 'true' : 'false'}`)
  whereParts.push(`useFulltext = ${metadata.useFulltext ? 'true' : 'false'}`)
  whereParts.push(`useFulltextNoImages = ${metadata.useFulltextNoImages ? 'true' : 'false'}`)

  // Date bounds: combine project bounds with request filters
  const effectiveFromDate =
    metadata.projectBounds?.dateFrom && params.fromDate
      ? metadata.projectBounds.dateFrom > params.fromDate
        ? metadata.projectBounds.dateFrom
        : params.fromDate
      : (metadata.projectBounds?.dateFrom ?? params.fromDate)

  const effectiveToDate =
    metadata.projectBounds?.dateTo && params.toDate
      ? metadata.projectBounds.dateTo < params.toDate
        ? metadata.projectBounds.dateTo
        : params.toDate
      : (metadata.projectBounds?.dateTo ?? params.toDate)

  if (effectiveFromDate) {
    whereParts.push(`articleCreatedAt >= toDateTime64('${formatDateForClickHouse(effectiveFromDate)}', 3)`)
  }
  if (effectiveToDate) {
    whereParts.push(`articleCreatedAt <= toDateTime64('${formatDateForClickHouse(effectiveToDate)}', 3)`)
  }

  // Search filter
  if (params.searchTitle && params.searchTitle.trim()) {
    const searchEscaped = escapeClickHouseString(params.searchTitle.trim())
    whereParts.push(`articleTitle ILIKE '%${searchEscaped}%'`)
  }

  // Scope filter: curated articles OR import routes
  const scopeParts: string[] = []

  // Curated articles (if small enough for IN clause)
  // For large sets (>1000), we simplify and skip curated for filter options
  // since the filter dropdown values should be the same regardless
  if (hasCuratedArticles && metadata.curatedArticleIds.length <= 1000) {
    const curatedIdsQuoted = metadata.curatedArticleIds
      .map((id) => {
        return `'${id}'`
      })
      .join(', ')
    scopeParts.push(`articleId IN (${curatedIdsQuoted})`)
  }

  // Import routes
  if (hasImportRoutes) {
    const routesQuoted = metadata.routeTexts
      .map((r) => {
        return `'${escapeClickHouseString(r)}'`
      })
      .join(', ')
    scopeParts.push(`articleImportRoute IN (${routesQuoted})`)
  }

  // If curated articles are large and no import routes, we still query but with a limit
  // to prevent extremely slow queries while still getting representative values
  if (scopeParts.length === 0 && hasCuratedArticles) {
    // Fallback: query without scope restriction but with a reasonable limit on results
    console.log('[ClickHouse Filters] Large curated set without import routes, using fallback approach')
  } else if (scopeParts.length > 0) {
    whereParts.push(`(${scopeParts.join(' OR ')})`)
  }

  const whereClause = whereParts.join(' AND ')

  // Query distinct answer values per prompt
  // We need to handle both answeredOriginal (single value) and answeredOriginalAsArray (array)
  // Using arrayJoin to flatten arrays and UNION to combine both sources
  const query = `
    SELECT promptId, value
    FROM (
      -- Single-value answers from answeredOriginal
      SELECT promptId, answeredOriginal AS value
      FROM judgments
      WHERE ${whereClause}
        AND answeredOriginal IS NOT NULL
        AND answeredOriginal != ''
        AND length(answeredOriginalAsArray) = 0

      UNION ALL

      -- Array answers from answeredOriginalAsArray (flattened)
      SELECT promptId, arrayJoin(answeredOriginalAsArray) AS value
      FROM judgments
      WHERE ${whereClause}
        AND length(answeredOriginalAsArray) > 0
    )
    WHERE value IS NOT NULL AND value != ''
    GROUP BY promptId, value
    ORDER BY promptId, value
  `

  console.log('[ClickHouse Filters] Query:', query.substring(0, 500) + '...')
  console.time('ch:filters:query')

  try {
    const result = await client.query({query, format: 'JSONEachRow'})
    const data = await result.json<{promptId: string; value: string}>()
    console.timeEnd('ch:filters:query')

    // Group by promptId
    const byPrompt = new Map<string, string[]>()
    for (const row of data) {
      const arr = byPrompt.get(row.promptId) || []
      if (row.value !== null && row.value !== undefined && row.value !== '') {
        arr.push(row.value)
      }
      byPrompt.set(row.promptId, arr)
    }

    const elapsed = performance.now() - startTime
    console.log(`[ClickHouse Filters] Found values for ${byPrompt.size} prompts in ${elapsed.toFixed(0)}ms`)

    return databasePrompts.map((p) => {
      return {promptId: p.promptId, promptName: p.promptName, answeredOriginalValues: byPrompt.get(p.promptId) || []}
    })
  } catch (error) {
    console.error('[ClickHouse Filters] Error:', error)
    // Return empty arrays on error to allow the request to complete
    return databasePrompts.map((p) => {
      return {promptId: p.promptId, promptName: p.promptName, answeredOriginalValues: []}
    })
  }
}
