/**
 * Admin routes for investigating unexpected answer values
 */
import {and, eq, isNotNull, sql} from 'drizzle-orm'
import {Elysia, t} from 'elysia'

import {judgments, projectPrompts, projects, prompts} from '../../db/schema.ts'
import {requireUserAuth} from '../utils/authGuard.ts'
import {getDatabase} from '../utils/getDatabase.ts'
import {withErrorHandler} from '../utils/routeErrorHandler.ts'

const parseArktypeOptions = (typeStr: string | null): string[] => {
  if (!typeStr) return []
  const matches = typeStr.match(/['"]([^'"]+)['"]/g)
  return (
    matches?.map((m) => {
      return m.slice(1, -1)
    }) ?? []
  )
}

const isArrayType = (typeStr: string | null): boolean => {
  if (!typeStr) return false
  return typeStr.includes('[]')
}

const isOpenEndedType = (typeStr: string | null): boolean => {
  if (!typeStr) return true
  const hasQuotedLiterals = /['"]/.test(typeStr)
  return !hasQuotedLiterals
}

export const adminInvestigateRoutes = new Elysia()
  .use(withErrorHandler())
  .use(requireUserAuth())
  .get(
    '/api/admin/investigate-unexpected-answers',
    async ({query}) => {
      const db = getDatabase()
      const projectId = query.projectId
      const promptId = query.promptId

      console.log(
        `[Admin] Fetching prompts${projectId ? ` for project ${projectId}` : ''}${promptId ? ` for prompt ${promptId}` : ''}...`,
      )

      // If projectId provided, get project info
      let projectName = 'All Projects'
      if (projectId) {
        const [project] = await db
          .select({name: projects.name})
          .from(projects)
          .where(eq(projects.id, projectId))
          .limit(1)
        if (!project) {
          throw new Error('Project not found')
        }
        projectName = project.name
      }

      // Fetch prompts - filter by project and/or promptId if specified
      let promptsQuery
      if (promptId) {
        // Single prompt mode
        promptsQuery = db
          .select({id: prompts.id, promptHeading: prompts.promptHeading, type: prompts.type})
          .from(prompts)
          .where(and(eq(prompts.id, promptId), isNotNull(prompts.type)))
      } else if (projectId) {
        // Project mode - all prompts in project
        promptsQuery = db
          .select({id: prompts.id, promptHeading: prompts.promptHeading, type: prompts.type})
          .from(prompts)
          .innerJoin(projectPrompts, eq(projectPrompts.promptId, prompts.id))
          .where(
            and(eq(projectPrompts.projectId, projectId), isNotNull(prompts.type), eq(projectPrompts.enabled, true)),
          )
      } else {
        // All prompts mode
        promptsQuery = db
          .select({id: prompts.id, promptHeading: prompts.promptHeading, type: prompts.type})
          .from(prompts)
          .where(isNotNull(prompts.type))
      }

      const allPrompts = await promptsQuery

      console.log(`[Admin] Found ${allPrompts.length} prompts with defined types`)

      const results: Array<{
        promptId: string
        promptHeading: string
        expectedOptions: string[]
        unexpectedAnswers: Array<{value: string | null; count: number}>
        totalJudgments: number
        percentUnexpected: number
      }> = []

      for (const prompt of allPrompts) {
        if (isOpenEndedType(prompt.type)) continue
        const expectedOptions = parseArktypeOptions(prompt.type)
        if (expectedOptions.length === 0) continue

        // Get all distinct answers for this prompt
        const isArray = isArrayType(prompt.type)

        let totalJudgments: number
        let unexpectedAnswers: Array<{value: string | null; count: number}>

        if (isArray) {
          const arrayAnswersQuery = await db
            .select({answeredOriginalAsArray: judgments.answeredOriginalAsArray, count: sql<number>`COUNT(*)::int`})
            .from(judgments)
            .where(sql`${judgments.promptId} = ${prompt.id}::uuid AND ${judgments.deletedAt} IS NULL`)
            .groupBy(judgments.answeredOriginalAsArray)

          totalJudgments = arrayAnswersQuery.reduce((sum, a) => {
            return sum + a.count
          }, 0)

          unexpectedAnswers = arrayAnswersQuery
            .filter((a) => {
              const arrayAnswer = a.answeredOriginalAsArray
              if (arrayAnswer === null) return true
              if (!Array.isArray(arrayAnswer)) return true
              if (arrayAnswer.length === 0) return true
              return arrayAnswer.some((elem) => {
                return !expectedOptions.includes(elem)
              })
            })
            .map((a) => {
              const arrayValue = a.answeredOriginalAsArray
              return {value: arrayValue === null ? null : JSON.stringify(arrayValue), count: a.count}
            })
            .sort((a, b) => {
              return b.count - a.count
            })
        } else {
          const stringAnswersQuery = await db
            .select({answeredOriginal: judgments.answeredOriginal, count: sql<number>`COUNT(*)::int`})
            .from(judgments)
            .where(sql`${judgments.promptId} = ${prompt.id}::uuid AND ${judgments.deletedAt} IS NULL`)
            .groupBy(judgments.answeredOriginal)

          totalJudgments = stringAnswersQuery.reduce((sum, a) => {
            return sum + a.count
          }, 0)

          unexpectedAnswers = stringAnswersQuery
            .filter((a) => {
              const answer = a.answeredOriginal
              if (answer === null) return true
              if (answer === '') return true
              return !expectedOptions.includes(answer)
            })
            .map((a) => {
              return {value: a.answeredOriginal, count: a.count}
            })
            .sort((a, b) => {
              return b.count - a.count
            })
        }

        if (unexpectedAnswers.length > 0) {
          const unexpectedCount = unexpectedAnswers.reduce((sum, ua) => {
            return sum + ua.count
          }, 0)
          const percentUnexpected = (unexpectedCount / totalJudgments) * 100

          results.push({
            promptId: prompt.id,
            promptHeading: prompt.promptHeading || 'Untitled',
            expectedOptions,
            unexpectedAnswers,
            totalJudgments,
            percentUnexpected,
          })
        }
      }

      console.log(`[Admin] Found ${results.length} prompts with unexpected answers`)

      // If promptId specified, return single-prompt format
      if (promptId) {
        const promptHeading = allPrompts[0]?.promptHeading || 'Untitled'
        const result = results.length > 0 ? results[0] : null
        return {projectName, promptHeading, result}
      }

      // Otherwise return multi-prompt format
      return {
        summary: {totalPromptsWithTypes: allPrompts.length, promptsWithUnexpectedAnswers: results.length},
        results: results.sort((a, b) => {
          return b.percentUnexpected - a.percentUnexpected
        }), // Sort by % unexpected descending
        projectName,
      }
    },
    {query: t.Object({projectId: t.Optional(t.String()), promptId: t.Optional(t.String())})},
  )
