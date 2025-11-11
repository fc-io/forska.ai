import {and, eq, inArray} from 'drizzle-orm'
import {Elysia, t} from 'elysia'

import {user} from '../../../../auth-schema.ts'
import {articles, judgmentAssessments, judgments, judgmentsHuman, prompts, projectPrompts, reviews} from '../../../db/schema.ts'
import {getDatabase} from '../../utils/getDatabase.ts'

export const projectsRoutesPostArticleReviewDetails = new Elysia().post(
  '/api/projectsreview',
  async ({body}) => {
    try {
      const db = getDatabase()
      const {projectId, articleId} = body

      // Get the article
      const [article] = await db.select().from(articles).where(eq(articles.id, articleId)).limit(1)

      if (!article) {
        throw new Error('Article not found')
      }

      // Get the review for this article in this project
      const [review] = await db
        .select()
        .from(reviews)
        .where(and(eq(reviews.articleId, articleId), eq(reviews.projectId, projectId)))
        .limit(1)

      // Get all prompts for this project (association)
      const projectPrompts = await db
        .select({
          id: prompts.id,
          originalText: prompts.originalText,
          promptHeading: projectPrompts.promptHeading,
          order: projectPrompts.order,
          type: projectPrompts.type,
        })
        .from(projectPrompts)
        .innerJoin(prompts, eq(projectPrompts.promptId, prompts.id))
        .where(eq(projectPrompts.projectId, projectId))
        .orderBy(projectPrompts.order)

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
              .innerJoin(projectPrompts, eq(projectPrompts.promptId, prompts.id))
              .where(and(eq(judgments.articleId, articleId), eq(projectPrompts.projectId, projectId)))
              .orderBy(projectPrompts.order)
          : []

      // Get judgment assessments for these judgments
      const judgmentIds = articleJudgments.map((j) => {
        return j.judgment.id
      })
      const assessments =
        judgmentIds.length > 0
          ? await db.select().from(judgmentAssessments).where(inArray(judgmentAssessments.judgmentId, judgmentIds))
          : []

      // Group assessments by judgment ID
      const assessmentsByJudgment = assessments.reduce(
        (acc, assessment) => {
          const judgmentAssessments = acc[assessment.judgmentId] ?? []
          return {...acc, [assessment.judgmentId]: [...judgmentAssessments, assessment]}
        },
        {} as Record<string, typeof assessments>,
      )

      // Combine judgments with their assessments and prompts
      const judgmentsWithDetails = articleJudgments.map(({judgment, prompt}) => {
        return {...judgment, prompt, assessments: assessmentsByJudgment[judgment.id] || []}
      })

      // Fetch human judgments for this article within this project, grouped by user
      const humanRows = await db
        .select({
          userId: judgmentsHuman.user,
          userName: user.name,
          judgmentId: judgmentsHuman.id,
          promptId: judgmentsHuman.promptId,
          answer: judgmentsHuman.answer,
          comment: judgmentsHuman.comment,
          promptOriginalText: prompts.originalText,
          promptOrder: projectPrompts.order,
        })
        .from(judgmentsHuman)
        .innerJoin(user, eq(user.id, judgmentsHuman.user))
        .innerJoin(prompts, eq(prompts.id, judgmentsHuman.promptId))
        .innerJoin(projectPrompts, eq(projectPrompts.promptId, prompts.id))
        .where(and(eq(judgmentsHuman.articleId, articleId), eq(judgmentsHuman.projectId, projectId), eq(judgmentsHuman.isAnswered, true)))
        .orderBy(user.name, projectPrompts.order)

      const humanByUser = humanRows.reduce(
        (acc, row) => {
          const current = acc[row.userId] ?? {
            userId: row.userId,
            userName: row.userName,
            judgments: [] as Array<{
              id: string
              prompt: {originalText: string}
              answer: string | null
              comment: string | null
            }>,
          }
          const next = {
            id: row.judgmentId,
            prompt: {originalText: row.promptOriginalText},
            answer: row.answer,
            comment: row.comment,
          }
          return {...acc, [row.userId]: {...current, judgments: [...current.judgments, next]}}
        },
        {} as Record<
          string,
          {
            userId: string
            userName: string
            judgments: Array<{
              id: string
              prompt: {originalText: string}
              answer: string | null
              comment: string | null
            }>
          }
        >,
      )

      const humanAssessmentsByUser = Object.values(humanByUser)

      return {article, review, prompts: projectPrompts, judgments: judgmentsWithDetails, humanAssessmentsByUser}
    } catch (error) {
      console.error('Error fetching article review details:', error)
      throw new Error(error instanceof Error ? error.message : 'Failed to fetch article review details')
    }
  },
  {body: t.Object({projectId: t.String(), articleId: t.String()})},
)
