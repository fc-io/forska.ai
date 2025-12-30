/**
 * Articles reviews filters API endpoint - ClickHouse implementation.
 *
 * This endpoint returns filter options for the articles reviews page.
 * Two strategies are used:
 * 1. Enum-based: Parse the prompt's arktype `type` field (no database query)
 * 2. Database-based: Query ClickHouse for distinct answer values (open-ended prompts)
 *
 * Phase 6 migration: Database queries moved from PostgreSQL to ClickHouse.
 */
import {and, eq} from 'drizzle-orm'
import {Elysia, t} from 'elysia'

import {projectPrompts, prompts} from '../../../db/schema.ts'
import {
  type ClickHouseFilterResult,
  getDatabaseBasedFiltersFromClickHouse,
} from '../../../services/clickhouse/articlesReviewsFiltersClickHouse.ts'
import {getDatabase} from '../../utils/getDatabase.ts'
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

      // Get enum-based filter options (from prompt type definitions - no DB query needed)
      const enumFilters = getEnumBasedFilters(analyzedPrompts)

      // For prompts with database strategy, query ClickHouse for distinct answer values
      const databasePrompts = analyzedPrompts.filter((p) => {
        return p.strategy === 'database'
      })
      let databaseFilters: ClickHouseFilterResult[] = []

      if (databasePrompts.length > 0) {
        // Query ClickHouse for open-ended prompt filter values
        databaseFilters = await getDatabaseBasedFiltersFromClickHouse({
          projectId: query.projectId,
          prompts: analyzedPrompts,
          fromDate,
          toDate,
          searchTitle,
        })
      }

      // Combine results, maintaining original prompt order
      const resultMap = new Map<string, EnumFilterResult | ClickHouseFilterResult>()
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
