import {Elysia, t} from 'elysia'

import {
  type DatabaseFilterResult,
  getDatabaseBasedFiltersFromOlap,
  getNumericFiltersFromOlap,
} from '../../../services/olap/articlesReviewsFiltersOlap.ts'
import {getAppQueryService} from '../../services/getAppQueryService.ts'
import {createRateLimitedLogger} from '../../utils/rateLimitedLogger.ts'
import {type EnumFilterResult, getEnumBasedFilters} from './articlesReviewsFiltersEnum.ts'
import type {NumericFilterResult} from './articlesReviewsFiltersNumeric.ts'
import {analyzePromptTypes} from './articlesReviewsFiltersUtils.ts'
import {assertProjectIsActive} from './projectAccessGuard.ts'

const articlesReviewsFiltersLogger = createRateLimitedLogger({sink: 'file-only', windowMs: 30_000})
const articlesReviewsFiltersErrorLogger = createRateLimitedLogger({sink: 'both', windowMs: 30_000})

export const projectsRoutesGetArticlesReviewsFilters = new Elysia().get(
  '/api/articlesreviewsfilters',
  async ({query, set}) => {
    try {
      if (!query?.projectId) {
        set.status = 400
        throw new Error('Project ID is required')
      }

      await assertProjectIsActive(query.projectId)

      const fromDate = query?.from ? new Date(`${query.from}T00:00:00.000Z`) : null
      const toDate = query?.to ? new Date(`${query.to}T23:59:59.999Z`) : null
      const hasDuplicateStudyRecords = query?.covidenceDuplicates === '1'
      const hasStudyDecisionConflict = query?.covidenceConflicts === '1'
      const searchTitle = typeof query?.search === 'string' ? query.search.trim() : ''
      articlesReviewsFiltersLogger.force(
        'projects.articles-reviews-filters.request-start',
        'Articles reviews filters request started',
        'log',
        {
          projectId: query.projectId,
          from: query.from,
          to: query.to,
          search: searchTitle,
          hasDuplicateStudyRecords,
          hasStudyDecisionConflict,
        },
      )

      // Get all prompts for this project with their type information
      const projectPromptRows = await getAppQueryService().getProjectPromptRows(query.projectId)

      if (projectPromptRows.length === 0) {
        articlesReviewsFiltersLogger.force(
          'projects.articles-reviews-filters.request-summary',
          'Articles reviews filters request completed',
          'log',
          {
            projectId: query.projectId,
            promptCount: 0,
            enumFilterCount: 0,
            databaseFilterCount: 0,
            numericFilterCount: 0,
            resultFilterCount: 0,
          },
        )
        return []
      }

      // Analyze each prompt's type to determine filter strategy
      const analyzedPrompts = analyzePromptTypes(projectPromptRows)

      // Get enum-based filter options (from prompt type definitions - no DB query needed)
      const enumFilters = getEnumBasedFilters(analyzedPrompts)

      // For prompts with database strategy, query OLAP for distinct answer values
      const hasDatabasePrompts = analyzedPrompts.some((p) => {
        return p.strategy === 'database'
      })

      // For prompts with numeric strategy, query OLAP for min/max values
      const hasNumericPrompts = analyzedPrompts.some((p) => {
        return p.strategy === 'numeric'
      })

      // Run both queries in parallel if needed
      const [databaseFilters, numericFilters] = await Promise.all([
        hasDatabasePrompts
          ? getDatabaseBasedFiltersFromOlap({
              projectId: query.projectId,
              prompts: analyzedPrompts,
              hasDuplicateStudyRecords,
              hasStudyDecisionConflict,
              fromDate,
              toDate,
              searchTitle,
            })
          : ([] as DatabaseFilterResult[]),
        hasNumericPrompts
          ? getNumericFiltersFromOlap({
              projectId: query.projectId,
              prompts: analyzedPrompts,
              hasDuplicateStudyRecords,
              hasStudyDecisionConflict,
              fromDate,
              toDate,
              searchTitle,
            })
          : ([] as NumericFilterResult[]),
      ])

      // Combine results, maintaining original prompt order
      const enumResultMap = new Map<string, EnumFilterResult | DatabaseFilterResult>()
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

      articlesReviewsFiltersLogger.force(
        'projects.articles-reviews-filters.request-summary',
        'Articles reviews filters request completed',
        'log',
        {
          projectId: query.projectId,
          promptCount: projectPromptRows.length,
          enumFilterCount: enumFilters.length,
          databaseFilterCount: databaseFilters.length,
          numericFilterCount: numericFilters.length,
          resultFilterCount: result.length,
        },
      )

      return result
    } catch (error) {
      articlesReviewsFiltersErrorLogger.force(
        'projects.articles-reviews-filters.error',
        'Articles reviews filters request failed',
        'error',
        {projectId: query?.projectId, error: error instanceof Error ? error.message : String(error)},
      )
      set.status = 500
      throw new Error(error instanceof Error ? error.message : 'Failed to fetch articles reviews filters', {
        cause: error,
      })
    }
  },
  {
    query: t.Object({
      projectId: t.String(),
      covidenceConflicts: t.Optional(t.String()),
      covidenceDuplicates: t.Optional(t.String()),
      from: t.Optional(t.String()),
      to: t.Optional(t.String()),
      search: t.Optional(t.String()),
    }),
  },
)
