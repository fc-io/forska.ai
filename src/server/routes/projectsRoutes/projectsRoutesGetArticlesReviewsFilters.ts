import {and, eq, or, sql} from 'drizzle-orm'
import {Elysia, t} from 'elysia'

import {
  articleRouteLink,
  articles,
  projectArticles,
  projectPrompts,
  projectRouteLink,
  projects,
  prompts,
} from '../../../db/schema.ts'
import {getDatabase} from '../../utils/getDatabase.ts'
import {type DatabaseFilterResult, getDatabaseBasedFilters} from './articlesReviewsFiltersDatabase.ts'
import {type EnumFilterResult, getEnumBasedFilters} from './articlesReviewsFiltersEnum.ts'
import {analyzePromptTypes} from './articlesReviewsFiltersUtils.ts'

export const projectsRoutesGetArticlesReviewsFilters = new Elysia().get(
  '/api/articlesreviewsfilters',
  async ({query, set}) => {
    console.log('articlesreviewsfilters', query)
    try {
      const db = getDatabase()

      if (!query?.projectId) {
        set.status = 400
        throw new Error('Project ID is required')
      }

      const fromDate = query?.from ? new Date(`${query.from}T00:00:00.000Z`) : null
      const toDate = query?.to ? new Date(`${query.to}T23:59:59.999Z`) : null
      const searchTitle = typeof query?.search === 'string' ? query.search.trim() : ''

      // Get all prompts for this project with their type information
      const projectPromptRows = await db
        .select({
          id: prompts.id,
          promptHeading: prompts.promptHeading,
          originalText: prompts.originalText,
          type: prompts.type,
        })
        .from(projectPrompts)
        .innerJoin(prompts, eq(projectPrompts.promptId, prompts.id))
        .where(and(eq(projectPrompts.projectId, query.projectId), eq(projectPrompts.enabled, true)))

      if (projectPromptRows.length === 0) {
        return []
      }

      // Analyze each prompt's type to determine filter strategy
      const analyzedPrompts = analyzePromptTypes(projectPromptRows)

      // Get enum-based filter options (from prompt type definitions)
      const enumFilters = getEnumBasedFilters(analyzedPrompts)

      // For prompts with database strategy, we need to query the database
      const databasePrompts = analyzedPrompts.filter((p) => {
        return p.strategy === 'database'
      })
      let databaseFilters: DatabaseFilterResult[] = []

      if (databasePrompts.length > 0) {
        // Get project bounds and import routes for database queries
        const [projectBounds] = await db
          .select({dateFrom: projects.dateFrom, dateTo: projects.dateTo})
          .from(projects)
          .where(eq(projects.id, query.projectId))
          .limit(1)

        const projectImportRoutes = await db
          .select({importRouteId: projectRouteLink.importRouteId})
          .from(projectRouteLink)
          .where(eq(projectRouteLink.projectId, query.projectId))

        const hasImportRoutes = projectImportRoutes.length > 0
        const routeIdArray = hasImportRoutes
          ? sql.join(
              projectImportRoutes.map((r) => {
                return sql`${r.importRouteId}::uuid`
              }),
              sql`,`,
            )
          : null

        // Build scope condition
        const hasMatchingImportRoute = hasImportRoutes
          ? sql`EXISTS (
              SELECT 1 FROM ${articleRouteLink} arl
              WHERE arl."article_id" = ${articles.id}
                AND arl."import_route_id" = ANY(ARRAY[${routeIdArray}])
            )`
          : undefined
        const hasProjectArticle = sql`EXISTS (
          SELECT 1 FROM ${projectArticles} pa
          WHERE pa."article_id" = ${articles.id}
            AND pa."project_id" = ${query.projectId}::uuid
        )`
        const orResult = hasImportRoutes ? or(hasMatchingImportRoute, hasProjectArticle) : undefined
        const scopeCondition = orResult ?? hasProjectArticle

        // Query database for open-ended prompt filters
        databaseFilters = await getDatabaseBasedFilters(db, {
          prompts: analyzedPrompts,
          scopeCondition,
          projectBounds,
          fromDate,
          toDate,
          searchTitle,
        })
      }

      // Combine results, maintaining original prompt order
      const resultMap = new Map<string, EnumFilterResult | DatabaseFilterResult>()
      for (const filter of enumFilters) {
        resultMap.set(filter.promptId, filter)
      }
      for (const filter of databaseFilters) {
        resultMap.set(filter.promptId, filter)
      }

      // Return in the order prompts appear
      const result = projectPromptRows.map((p) => {
        const filter = resultMap.get(p.id)
        return {
          promptId: p.id,
          promptName: filter?.promptName || p.promptHeading || p.originalText,
          answeredOriginalValues: filter?.answeredOriginalValues || [],
        }
      })

      return result
    } catch (error) {
      console.error('Error fetching articles reviews filters:', error)
      set.status = 500
      throw new Error(error instanceof Error ? error.message : 'Failed to fetch articles reviews filters')
    }
  },
  {
    query: t.Object({
      projectId: t.String(),
      from: t.Optional(t.String()),
      to: t.Optional(t.String()),
      search: t.Optional(t.String()),
    }),
  },
)
