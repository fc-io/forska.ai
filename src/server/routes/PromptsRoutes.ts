import {and, eq, inArray, sql} from 'drizzle-orm'
import {Elysia, t} from 'elysia'

import {judgments, judgmentsHuman, projectPrompts, prompts} from '../../db/schema'
import {getDatabase} from '../utils/getDatabase'

export const promptsRoutes = new Elysia({prefix: '/api/prompts'})
  .get('/duplicates', async () => {
    const db = getDatabase()
    const allPrompts = await db.select().from(prompts)

    // Group by content
    const groups = new Map<string, typeof allPrompts>()
    for (const p of allPrompts) {
      // Create a key based on content fields
      const key = JSON.stringify({originalText: p.originalText, promptHeading: p.promptHeading, type: p.type})

      if (!groups.has(key)) {
        groups.set(key, [])
      }
      groups.get(key)!.push(p)
    }

    // Filter for duplicates
    const duplicateGroups = Array.from(groups.values()).filter((group) => {
      return group.length > 1
    })

    // Enrich with usage stats
    const result = await Promise.all(
      duplicateGroups.map(async (group) => {
        const enrichedPrompts = await Promise.all(
          group.map(async (p) => {
            const [projectCount] = await db
              .select({count: sql<number>`count(*)`})
              .from(projectPrompts)
              .where(eq(projectPrompts.promptId, p.id))

            const [judgmentCount] = await db
              .select({count: sql<number>`count(*)`})
              .from(judgments)
              .where(eq(judgments.promptId, p.id))

            const [humanJudgmentCount] = await db
              .select({count: sql<number>`count(*)`})
              .from(judgmentsHuman)
              .where(eq(judgmentsHuman.promptId, p.id))

            // Fetch project names for better context
            const projects = await db
              .select({
                id: projectPrompts.projectId,
                // We would need to join with projects table to get names,
                // but for now let's just get the IDs or count.
                // Let's try to get project names if possible, but schema import might be needed.
                // For simplicity, let's just return counts and maybe IDs.
              })
              .from(projectPrompts)
              .where(eq(projectPrompts.promptId, p.id))

            return {
              ...p,
              usage: {
                projects: Number(projectCount?.count ?? 0),
                judgments: Number(judgmentCount?.count ?? 0),
                humanJudgments: Number(humanJudgmentCount?.count ?? 0),
                projectIds: projects.map((pr) => {
                  return pr.id
                }),
              },
            }
          }),
        )
        return enrichedPrompts
      }),
    )

    return {success: true, data: result}
  })
  .delete('/:id', async ({params}) => {
    const db = getDatabase()
    const {id} = params

    // Strict verification: Ensure no connections exist
    const [projectCount] = await db
      .select({count: sql<number>`count(*)`})
      .from(projectPrompts)
      .where(eq(projectPrompts.promptId, id))

    const [judgmentCount] = await db
      .select({count: sql<number>`count(*)`})
      .from(judgments)
      .where(eq(judgments.promptId, id))

    const [humanJudgmentCount] = await db
      .select({count: sql<number>`count(*)`})
      .from(judgmentsHuman)
      .where(eq(judgmentsHuman.promptId, id))

    if ((projectCount?.count ?? 0) > 0 || (judgmentCount?.count ?? 0) > 0 || (humanJudgmentCount?.count ?? 0) > 0) {
      throw new Error('Prompt is not fully orphaned. It has existing connections.')
    }

    await db.delete(prompts).where(eq(prompts.id, id))

    return {success: true}
  })
  .get('/orphans', async () => {
    const db = getDatabase()

    const noProjects = await db
      .select({
        id: prompts.id,
        originalText: prompts.originalText,
        promptHeading: prompts.promptHeading,
        type: prompts.type,
        createdAt: prompts.createdAt,
      })
      .from(prompts)
      .leftJoin(projectPrompts, eq(prompts.id, projectPrompts.promptId))
      .where(sql`${projectPrompts.id} IS NULL`)

    const noJudgments = await db
      .select({
        id: prompts.id,
        originalText: prompts.originalText,
        promptHeading: prompts.promptHeading,
        type: prompts.type,
        createdAt: prompts.createdAt,
      })
      .from(prompts)
      .leftJoin(judgments, eq(prompts.id, judgments.promptId))
      .leftJoin(judgmentsHuman, eq(prompts.id, judgmentsHuman.promptId))
      .where(and(sql`${judgments.id} IS NULL`, sql`${judgmentsHuman.id} IS NULL`))

    const noProjectsAndJudgments = await db
      .select({
        id: prompts.id,
        originalText: prompts.originalText,
        promptHeading: prompts.promptHeading,
        type: prompts.type,
        createdAt: prompts.createdAt,
      })
      .from(prompts)
      .leftJoin(projectPrompts, eq(prompts.id, projectPrompts.promptId))
      .leftJoin(judgments, eq(prompts.id, judgments.promptId))
      .leftJoin(judgmentsHuman, eq(prompts.id, judgmentsHuman.promptId))
      .where(and(sql`${projectPrompts.id} IS NULL`, sql`${judgments.id} IS NULL`, sql`${judgmentsHuman.id} IS NULL`))

    return {success: true, data: {noProjects, noJudgments, noProjectsAndJudgments}}
  })
  .post(
    '/merge',
    async ({body}) => {
      const {keepPromptId, mergePromptIds} = body
      const db = getDatabase()

      await db.transaction(async (tx) => {
        for (const mergeId of mergePromptIds) {
          // 1. Handle Project Prompts
          const projectsUsingMerge = await tx.select().from(projectPrompts).where(eq(projectPrompts.promptId, mergeId))

          for (const p of projectsUsingMerge) {
            // Check if project already uses keepId
            const existing = await tx
              .select()
              .from(projectPrompts)
              .where(and(eq(projectPrompts.projectId, p.projectId), eq(projectPrompts.promptId, keepPromptId)))

            if (existing.length > 0) {
              // Project already has the target prompt, so just remove the duplicate link
              await tx
                .delete(projectPrompts)
                .where(and(eq(projectPrompts.projectId, p.projectId), eq(projectPrompts.promptId, mergeId)))
            } else {
              // Project doesn't have the target prompt, so update the link
              await tx
                .update(projectPrompts)
                .set({promptId: keepPromptId})
                .where(and(eq(projectPrompts.projectId, p.projectId), eq(projectPrompts.promptId, mergeId)))
            }
          }

          // 2. Handle Judgments
          await tx.update(judgments).set({promptId: keepPromptId}).where(eq(judgments.promptId, mergeId))

          // 3. Handle Human Judgments
          await tx.update(judgmentsHuman).set({promptId: keepPromptId}).where(eq(judgmentsHuman.promptId, mergeId))

          // 4. Delete the merged prompt
          await tx.delete(prompts).where(eq(prompts.id, mergeId))
        }
      })

      return {success: true}
    },
    {body: t.Object({keepPromptId: t.String(), mergePromptIds: t.Array(t.String())})},
  )
