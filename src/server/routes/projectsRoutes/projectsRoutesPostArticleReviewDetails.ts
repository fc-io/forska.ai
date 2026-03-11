import {and, eq, inArray, isNull, or, sql} from 'drizzle-orm'
import {Elysia, t} from 'elysia'

import {
  articles,
  judgmentAssessments,
  judgments,
  judgmentsHuman,
  models,
  projectPrompts,
  projects,
  prompts,
  reviews,
} from '../../../db/schema.ts'
import {getDatabase} from '../../utils/getDatabase.ts'
import {getLocalUser} from '../../utils/getLocalUser.ts'

type JudgmentWithPromptAndAssessments = typeof judgments.$inferSelect & {
  prompt: typeof prompts.$inferSelect
  assessments: Array<typeof judgmentAssessments.$inferSelect>
  modelName?: string | null
  modelProvider?: string | null
  modelVersion?: string | null
}

type PlaceholderJudgment = {
  id: string
  promptId: string
  answeredOriginal: 'not answered'
  confidenceOriginal: null
  explanation: null
  quotes: (typeof judgments.$inferSelect)['quotes']
  prompt: Pick<typeof prompts.$inferSelect, 'originalText' | 'promptHeading'>
  assessments: Array<typeof judgmentAssessments.$inferSelect>
  createdAt: null
  modelName?: string | null
  modelProvider?: string | null
  modelVersion?: string | null
}

type ReviewJudgment = JudgmentWithPromptAndAssessments | PlaceholderJudgment

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
      const projectPromptRows = await db
        .select({
          id: prompts.id,
          originalText: prompts.originalText,
          promptHeading: prompts.promptHeading,
          order: projectPrompts.order,
          type: prompts.type,
          enabled: projectPrompts.enabled,
          originProjectId: projectPrompts.originProjectId,
        })
        .from(projectPrompts)
        .innerJoin(prompts, eq(projectPrompts.promptId, prompts.id))
        .where(eq(projectPrompts.projectId, projectId))
        .orderBy(projectPrompts.order)

      // Get all judgments for this article that belong to prompts from this project
      const promptIds = projectPromptRows.map((p) => {
        return p.id
      })
      const articleJudgments =
        promptIds.length > 0
          ? await db
              .select({
                judgment: judgments,
                prompt: prompts,
                modelName: models.modelName,
                modelProvider: models.provider,
                modelVersion: models.version,
              })
              .from(judgments)
              .innerJoin(prompts, eq(judgments.promptId, prompts.id))
              .innerJoin(projectPrompts, eq(projectPrompts.promptId, prompts.id))
              .leftJoin(models, eq(judgments.modelId, models.id))
              .where(
                and(
                  eq(judgments.articleId, articleId),
                  eq(projectPrompts.projectId, projectId),
                  eq(projectPrompts.enabled, true), // Only enabled prompts in LLM assessment
                ),
              )
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
      const assessmentsByJudgment = assessments.reduce<Record<string, Array<typeof judgmentAssessments.$inferSelect>>>(
        (acc, assessment) => {
          const judgmentAssessments = acc[assessment.judgmentId] ?? []
          return {...acc, [assessment.judgmentId]: [...judgmentAssessments, assessment]}
        },
        {},
      )

      // Combine judgments with their assessments and prompts (limited to this project's ENABLED prompts)
      const judgmentsWithDetails: ReviewJudgment[] = articleJudgments.map(
        ({judgment, prompt, modelName, modelProvider, modelVersion}) => {
          const judgmentAssessments = assessmentsByJudgment[judgment.id] ?? []
          return {...judgment, prompt, assessments: judgmentAssessments, modelName, modelProvider, modelVersion}
        },
      )

      // Add placeholders for enabled prompts with no LLM judgment yet
      // If there are judgments for a prompt, do NOT add a placeholder for that prompt
      const enabledPromptRows = projectPromptRows.filter((p) => {
        return p.enabled === true
      })
      const presentPromptIds = new Set(
        articleJudgments.map(({judgment}) => {
          return judgment.promptId
        }),
      )
      const promptOrderMap = projectPromptRows.reduce(
        (acc, p, idx) => {
          const ord = p.order ?? idx
          acc[p.id] = ord
          return acc
        },
        {} as Record<string, number>,
      )

      const placeholders: PlaceholderJudgment[] = enabledPromptRows
        .filter((p) => {
          return !presentPromptIds.has(p.id)
        })
        .map((p) => {
          return {
            id: `placeholder:${p.id}`,
            promptId: p.id,
            answeredOriginal: 'not answered',
            confidenceOriginal: null,
            explanation: null,
            quotes: [] as (typeof judgments.$inferSelect)['quotes'],
            prompt: {originalText: p.originalText, promptHeading: p.promptHeading},
            assessments: [] as Array<typeof judgmentAssessments.$inferSelect>,
            createdAt: null,
          }
        })

      const judgmentsWithPlaceholders: ReviewJudgment[] = [...judgmentsWithDetails, ...placeholders]

      // Ensure stable ordering by project prompt order
      judgmentsWithPlaceholders.sort((a, b) => {
        const ao = promptOrderMap[a.promptId] ?? Number.MAX_SAFE_INTEGER
        const bo = promptOrderMap[b.promptId] ?? Number.MAX_SAFE_INTEGER
        if (ao !== bo) return ao - bo
        // Secondary: newer first if timestamps exist
        const at = a.createdAt ? new Date(a.createdAt).getTime() : 0
        const bt = b.createdAt ? new Date(b.createdAt).getTime() : 0
        return bt - at
      })

      // Cross-project:
      // - Include LLM judgments whose prompts are NOT linked to this project (anti-join)
      // - Include LLM judgments for imported prompts that are linked but DISABLED in this project
      //   (imported = origin_project_id IS NULL, enabled = false)
      const allArticleJudgments = await db
        .select({
          judgment: judgments,
          prompt: prompts,
          modelName: models.modelName,
          modelProvider: models.provider,
          modelVersion: models.version,
        })
        .from(judgments)
        .innerJoin(prompts, eq(judgments.promptId, prompts.id))
        .leftJoin(projectPrompts, and(eq(projectPrompts.promptId, prompts.id), eq(projectPrompts.projectId, projectId)))
        .leftJoin(models, eq(judgments.modelId, models.id))
        .where(
          and(
            eq(judgments.articleId, articleId),
            or(
              // Not linked to this project at all
              isNull(projectPrompts.id),
              // Linked but disabled, and imported (not created by this project)
              and(eq(projectPrompts.enabled, false), isNull(projectPrompts.originProjectId)),
            ),
          ),
        )

      const allJudgments = allArticleJudgments.map(({judgment, prompt, modelName, modelProvider, modelVersion}) => {
        return {...judgment, prompt, modelName, modelProvider, modelVersion}
      })

      // Resolve project names for snapshotProjectId when present
      const snapshotProjectIds = Array.from(
        new Set(
          allJudgments
            .map((j) => {
              return j.snapshotProjectId
            })
            .filter((id): id is string => {
              return Boolean(id)
            }),
        ),
      )
      const projectNameRows =
        snapshotProjectIds.length > 0
          ? await db
              .select({id: projects.id, name: projects.name})
              .from(projects)
              .where(inArray(projects.id, snapshotProjectIds))
          : []
      const projectsById = projectNameRows.reduce<Record<string, {name: string}>>((acc, row) => {
        acc[row.id] = {name: row.name}
        return acc
      }, {})

      const localUser = await getLocalUser()

      // Fetch human judgments for this article within this project.
      const humanRows = await db
        .select({
          judgmentId: judgmentsHuman.id,
          promptId: judgmentsHuman.promptId,
          answer: judgmentsHuman.answer,
          comment: judgmentsHuman.comment,
          promptOriginalText: prompts.originalText,
          promptOrder: projectPrompts.order,
        })
        .from(judgmentsHuman)
        .innerJoin(prompts, eq(prompts.id, judgmentsHuman.promptId))
        .innerJoin(
          projectPrompts,
          and(eq(projectPrompts.promptId, prompts.id), eq(projectPrompts.projectId, projectId)),
        )
        .where(
          and(
            eq(judgmentsHuman.articleId, articleId),
            eq(judgmentsHuman.projectId, projectId),
            eq(judgmentsHuman.isAnswered, true),
          ),
        )
        .orderBy(projectPrompts.order)

      const humanAssessmentsByUser =
        humanRows.length === 0
          ? []
          : [
              {
                userId: localUser.id,
                userName: localUser.name,
                judgments: humanRows.map((row) => {
                  return {
                    id: row.judgmentId,
                    prompt: {originalText: row.promptOriginalText},
                    answer: row.answer,
                    comment: row.comment,
                  }
                }),
              },
            ]

      let humanAnswersByPrompt: Record<string, Array<{userName: string; answer: string}>> | undefined = undefined
      if (promptIds.length > 0) {
        type HumanRow = {articleId: string; promptId: string; answer: string | null; updatedAt: Date | null}
        const rows: HumanRow[] = await db
          .select({
            articleId: judgmentsHuman.articleId,
            promptId: judgmentsHuman.promptId,
            answer: judgmentsHuman.answer,
            updatedAt: judgmentsHuman.updatedAt,
          })
          .from(judgmentsHuman)
          .where(and(eq(judgmentsHuman.articleId, articleId), sql`${judgmentsHuman.answer} IS NOT NULL`))

        // Deduplicate by latest updatedAt for (articleId, promptId)
        const latest = rows.reduce((acc, row) => {
          const key = `${row.articleId}::${row.promptId}`
          const existing = acc.get(key)
          if (!existing || (row.updatedAt?.getTime() || 0) > (existing.updatedAt?.getTime() || 0)) {
            acc.set(key, row)
          }
          return acc
        }, new Map<string, HumanRow>())

        const latestRows = Array.from(latest.values())
        const covered = new Set(
          latestRows.map((row) => {
            return row.promptId
          }),
        )

        if (covered.size === promptIds.length) {
          const map: Record<string, Array<{userName: string; answer: string}>> = {}
          for (const pid of promptIds) map[pid] = []
          for (const row of latestRows) {
            const arr = map[row.promptId]
            if (row.answer !== null && row.answer !== undefined && arr) {
              arr.push({userName: localUser.name, answer: row.answer})
            }
          }
          humanAnswersByPrompt = map
        }
      }

      return {
        article,
        review,
        prompts: projectPromptRows,
        judgments: judgmentsWithPlaceholders,
        // Cross-project extras
        allJudgments,
        projectsById,
        humanAssessmentsByUser,
        humanAnswersByPrompt,
      }
    } catch (error) {
      console.error('Error fetching article review details:', error)
      throw new Error(error instanceof Error ? error.message : 'Failed to fetch article review details')
    }
  },
  {body: t.Object({projectId: t.String(), articleId: t.String()})},
)
