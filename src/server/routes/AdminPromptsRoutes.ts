import {eq, inArray} from 'drizzle-orm'
import {Elysia, t} from 'elysia'

import {judgments, judgmentsHuman, prompts} from '../../db/schema.ts'
import {getDatabase} from '../utils/getDatabase.ts'
import {withErrorHandler} from '../utils/routeErrorHandler'

export const adminPromptsRoutes = new Elysia()
  .use(withErrorHandler())
  .get('/api/admin/prompts/duplicates', async () => {
    const db = getDatabase()

    const rows = await db
      .select({
        id: prompts.id,
        projectId: prompts.projectId,
        promptHeading: prompts.promptHeading,
        order: prompts.order,
        archived: prompts.archived,
        contentHash: prompts.contentHash,
      })
      .from(prompts)

    const byHash = rows.reduce<Record<string, typeof rows>>((acc, row) => {
      const key = row.contentHash || ''
      const arr = acc[key] ?? []
      acc[key] = [...arr, row]
      return acc
    }, {})

    const result = Object.entries(byHash)
      .filter(([, list]) => list.length > 1 && list.some((p) => !p.archived))
      .map(([contentHash, promptsList]) => ({contentHash, prompts: promptsList}))

    return {data: result}
  })
  .post(
    '/api/admin/prompts/canonicalize',
    async ({body, set}) => {
      const db = getDatabase()
      const {contentHash, canonicalPromptId} = body

      const dupRows = await db.select().from(prompts).where(eq(prompts.contentHash, contentHash))
      if (dupRows.length === 0) {
        set.status = 404
        return {data: null, error: 'No prompts found for contentHash'}
      }
      if (!dupRows.some((p) => p.id === canonicalPromptId)) {
        set.status = 400
        return {data: null, error: 'Canonical promptId not in duplicates set'}
      }

      await db.transaction(async (tx) => {
        const toChange = dupRows
          .map((p) => p.id)
          .filter((id) => id !== canonicalPromptId)

        if (toChange.length > 0) {
          await tx.update(judgments).set({promptId: canonicalPromptId}).where(inArray(judgments.promptId, toChange))
          await tx
            .update(judgmentsHuman)
            .set({promptId: canonicalPromptId})
            .where(inArray(judgmentsHuman.promptId, toChange))

          await tx.delete(prompts).where(inArray(prompts.id, toChange))
        }
      })

      return {success: true}
    },
    {body: t.Object({contentHash: t.String(), canonicalPromptId: t.String()})},
  )
