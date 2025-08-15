import {and, eq, inArray} from 'drizzle-orm'
import {Elysia} from 'elysia'

import {
  articles,
  judgmentAssessments,
  judgments,
  prompts,
  reviews,
} from '../../../db/schema.ts'
import {getDatabase} from '../../utils/getDatabase.ts'

export const projectsRoutesGetArticleReviewDetails = new Elysia().get(
  '/api/projectsreview/:projectId/:articleId',
  async ({params}) => {
    try {
      const db = getDatabase()
      const {projectId, articleId} = params

      // Get the article
      const [article] = await db
        .select()
        .from(articles)
        .where(eq(articles.id, articleId))
        .limit(1)

      if (!article) {
        return {data: null, error: 'Article not found'}
      }

      // Get the review for this article in this project
      const [review] = await db
        .select()
        .from(reviews)
        .where(
          and(
            eq(reviews.articleId, articleId),
            eq(reviews.projectId, projectId),
          ),
        )
        .limit(1)

      // Get all prompts for this project
      const projectPrompts = await db
        .select()
        .from(prompts)
        .where(eq(prompts.projectId, projectId))
        .orderBy(prompts.order)

      // Get all judgments for this article that belong to prompts from this project
      const promptIds = projectPrompts.map((p) => {
        return p.id
      })
      const articleJudgments =
        promptIds.length > 0
          ? await db
              .select({judgment: judgments, prompt: prompts})
              .from(judgments)
              .innerJoin(prompts, eq(judgments.promptId, prompts.id))
              .where(
                and(
                  eq(judgments.articleId, articleId),
                  eq(prompts.projectId, projectId),
                ),
              )
              .orderBy(prompts.order)
          : []

      // Get judgment assessments for these judgments
      const judgmentIds = articleJudgments.map((j) => {
        return j.judgment.id
      })
      const assessments =
        judgmentIds.length > 0
          ? await db
              .select()
              .from(judgmentAssessments)
              .where(inArray(judgmentAssessments.judgmentId, judgmentIds))
          : []

      // Group assessments by judgment ID
      const assessmentsByJudgment = assessments.reduce(
        (acc, assessment) => {
          const judgmentAssessments = acc[assessment.judgmentId] ?? []
          return {
            ...acc,
            [assessment.judgmentId]: [...judgmentAssessments, assessment],
          }
        },
        {} as Record<string, typeof assessments>,
      )

      // Combine judgments with their assessments and prompts
      const judgmentsWithDetails = articleJudgments.map(
        ({judgment, prompt}) => {
          return {
            ...judgment,
            prompt,
            assessments: assessmentsByJudgment[judgment.id] || [],
          }
        },
      )

      return {
        data: {
          article,
          review,
          prompts: projectPrompts,
          judgments: judgmentsWithDetails,
        },
      }
    } catch (error) {
      console.error('Error fetching article review details:', error)
      return {
        data: null,
        error:
          error instanceof Error
            ? error.message
            : 'Failed to fetch article review details',
      }
    }
  },
)
