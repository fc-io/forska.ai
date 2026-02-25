/**
 * Articles reviews filters API endpoint - ClickHouse implementation.
 *
 * This endpoint returns filter options for the articles reviews page.
 * Three strategies are used:
 * 1. Enum-based: Parse the prompt's arktype `type` field (no database query)
 * 2. Database-based: Query ClickHouse for distinct answer values (open-ended prompts)
 * 3. Numeric-based: Query ClickHouse for min/max values and generate bins (string.integer prompts)
 *
 * Phase 6 migration: Database queries moved from PostgreSQL to ClickHouse.
 */
import {and, eq} from 'drizzle-orm'
import {Elysia, t} from 'elysia'

import {projectPrompts, prompts} from '../../../db/schema.ts'
import {
  type ClickHouseFilterResult,
  getDatabaseBasedFiltersFromOlap,
  getNumericFiltersFromOlap,
} from '../../../services/olap/articlesReviewsFiltersOlap.ts'
import {getDatabase} from '../../utils/getDatabase.ts'
import {type EnumFilterResult, getEnumBasedFilters} from './articlesReviewsFiltersEnum.ts'
import type {NumericFilterResult} from './articlesReviewsFiltersNumeric.ts'
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
      const hasDatabasePrompts = analyzedPrompts.some((p) => {
        return p.strategy === 'database'
      })

      // For prompts with numeric strategy, query ClickHouse for min/max values
      const hasNumericPrompts = analyzedPrompts.some((p) => {
        return p.strategy === 'numeric'
      })

      // Run both queries in parallel if needed
      const [databaseFilters, numericFilters] = await Promise.all([
        hasDatabasePrompts
          ? getDatabaseBasedFiltersFromOlap({
              projectId: query.projectId,
              prompts: analyzedPrompts,
              fromDate,
              toDate,
              searchTitle,
            })
          : ([] as ClickHouseFilterResult[]),
        hasNumericPrompts
          ? getNumericFiltersFromOlap({
              projectId: query.projectId,
              prompts: analyzedPrompts,
              fromDate,
              toDate,
              searchTitle,
            })
          : ([] as NumericFilterResult[]),
      ])

      // Combine results, maintaining original prompt order
      const enumResultMap = new Map<string, EnumFilterResult | ClickHouseFilterResult>()
      for (const filter of enumFilters) {
        enumResultMap.set(filter.promptId, filter)
      }
      for (const filter of databaseFilters) {
        enumResultMap.set(filter.promptId, filter)
      }

      const numericResultMap = new Map<string, NumericFilterResult>()
      for (const filter of numericFilters) {
        numericResultMap.set(filter.promptId, filter)
      }

      // Return in the order prompts appear, with appropriate filter type
      type EnumOrDatabaseFilter = {
        promptId: string
        promptName: string
        filterType: 'enum'
        answeredOriginalValues: string[]
      }

      type ResultFilter = EnumOrDatabaseFilter | NumericFilterResult

      const result: ResultFilter[] = projectPromptRows.map((p) => {
        const numericFilter = numericResultMap.get(p.id)
        if (numericFilter) {
          return numericFilter
        }

        const enumFilter = enumResultMap.get(p.id)
        return {
          promptId: p.id,
          promptName: enumFilter?.promptName || p.promptHeading || p.originalText,
          filterType: 'enum' as const,
          answeredOriginalValues: enumFilter?.answeredOriginalValues || [],
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
