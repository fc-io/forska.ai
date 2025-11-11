import {and, eq, inArray, sql} from 'drizzle-orm'
import {Elysia, t} from 'elysia'

import {projectArticles, projectPrompts, judgments, judgmentsHuman, prompts} from '../../db/schema.ts'
import {getDatabase} from '../utils/getDatabase.ts'

export const projectArticlesRoutes = new Elysia()
  .post(
    '/api/projects/:id/articles',
    async ({params, body}) => {
      const db = getDatabase()
      const projectId = params.id
      const articleIds = Array.isArray(body.articleIds) ? body.articleIds : [body.articleIds]

      // Insert associations (ignore duplicates via unique constraint)
      if (articleIds.length > 0) {
        await db
          .insert(projectArticles)
          .values(
            articleIds.map((articleId) => {
              return {projectId, articleId}
            }),
          )
          .onConflictDoNothing({target: [projectArticles.projectId, projectArticles.articleId]})
      }

      // Auto-link prompts that already have judgments for these articles
      if (articleIds.length > 0) {
        // Distinct prompt ids that have any judgments (AI or human) for these articles
        const llmPromptIds = await db
          .select({pid: judgments.promptId})
          .from(judgments)
          .where(inArray(judgments.articleId, articleIds))
          .groupBy(judgments.promptId)
        const humanPromptIds = await db
          .select({pid: judgmentsHuman.promptId})
          .from(judgmentsHuman)
          .where(inArray(judgmentsHuman.articleId, articleIds))
          .groupBy(judgmentsHuman.promptId)

        const promptIdSet = new Set<string>([...llmPromptIds.map((r) => r.pid), ...humanPromptIds.map((r) => r.pid)])
        const promptIds = Array.from(promptIdSet)

        if (promptIds.length > 0) {
          // Exclude prompts already linked to this project
          const existing = await db
            .select({pid: projectPrompts.promptId})
            .from(projectPrompts)
            .where(eq(projectPrompts.projectId, projectId))

          const existingSet = new Set(existing.map((r) => r.pid))
          const toLink = promptIds.filter((pid) => {
            return !existingSet.has(pid)
          })

          if (toLink.length > 0) {
            // Ensure prompts exist; then insert associations with default metadata
            const ensurePrompts = await db.select({id: prompts.id}).from(prompts).where(inArray(prompts.id, toLink))
            const ensureIds = ensurePrompts.map((r) => r.id)
            if (ensureIds.length > 0) {
              await db
                .insert(projectPrompts)
                .values(
                  ensureIds.map((pid, index) => {
                    return {
                      projectId,
                      promptId: pid,
                      order: index,
                      archived: false,
                    }
                  }),
                )
                .onConflictDoNothing({target: [projectPrompts.projectId, projectPrompts.promptId]})
            }
          }
        }
      }

      return {success: true}
    },
    {body: t.Object({articleIds: t.Union([t.String(), t.Array(t.String())])})},
  )
  .delete('/api/projects/:id/articles/:articleId', async ({params}) => {
    const db = getDatabase()
    const {id: projectId, articleId} = params

    await db
      .delete(projectArticles)
      .where(and(eq(projectArticles.projectId, projectId), eq(projectArticles.articleId, articleId)))

    return {success: true}
  })
