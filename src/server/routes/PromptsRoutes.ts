import {and, desc, eq, sql} from 'drizzle-orm'
import {Elysia, t} from 'elysia'

import {auth} from '../../auth.ts'
import {judgments, judgmentsHuman, projectPrompts, prompts} from '../../db/schema'
import {requireAdminAuth, requireUserAuth} from '../utils/authGuard.ts'
import {computePromptContentHash} from '../utils/computePromptContentHash'
import {getDatabase} from '../utils/getDatabase'
import {withErrorHandler} from '../utils/routeErrorHandler'

type PromptRow = Pick<typeof prompts.$inferSelect, 'id' | 'originalText' | 'transformedText' | 'promptHeading' | 'type'>

type PromptCollision = {hash: string; promptIds: string[]}
type PromptHashUpdate = {id: string; hash: string}

const withHashes = (rows: PromptRow[]) => {
  return rows.map((row) => {
    return {...row, hash: computePromptContentHash(row.originalText, row.transformedText, row.promptHeading, row.type)}
  })
}

const groupCollisions = (rows: Array<PromptRow & {hash: string}>) => {
  return rows.reduce<Map<string, string[]>>((map, row) => {
    const current = map.get(row.hash) ?? []
    current.push(row.id)
    map.set(row.hash, current)
    return map
  }, new Map<string, string[]>())
}

const getCollisions = (groups: Map<string, string[]>) => {
  return Array.from(groups.entries())
    .filter(([, ids]) => {
      return ids.length > 1
    })
    .map<PromptCollision>(([hash, ids]) => {
      return {hash, promptIds: ids}
    })
}

const safeUpdates = (rows: Array<PromptRow & {hash: string}>, collisions: PromptCollision[]) => {
  const blocked = new Set(
    collisions.map((collision) => {
      return collision.hash
    }),
  )
  return rows
    .filter((row) => {
      return !blocked.has(row.hash)
    })
    .map<PromptHashUpdate>((row) => {
      return {id: row.id, hash: row.hash}
    })
}

const applyHashUpdates = async (db: ReturnType<typeof getDatabase>, updates: PromptHashUpdate[]) => {
  if (updates.length === 0) {
    return 0
  }

  const values = sql.join(
    updates.map((update) => {
      return sql`(${update.id}::uuid, ${update.hash})`
    }),
    sql`,`,
  )

  const result = await db.execute(
    sql<{id: string}>`
      UPDATE "prompts" AS p
      SET "content_hash" = v.content_hash
      FROM (VALUES ${values}) AS v(id, content_hash)
      WHERE p.id = v.id
      RETURNING p.id
    `,
  )

  return result.rows.length
}

const promptsListSelection = {
  id: prompts.id,
  originalText: prompts.originalText,
  promptHeading: prompts.promptHeading,
  type: prompts.type,
  createdAt: prompts.createdAt,
  updatedAt: prompts.updatedAt,
  ownerId: prompts.ownerId,
  archived: prompts.archived,
}

const promptsUserRoutes = new Elysia()
  .use(withErrorHandler())
  .use(requireUserAuth())
  .get('/api/prompts', async () => {
    const db = getDatabase()
    const list = await db
      .select(promptsListSelection)
      .from(prompts)
      .where(eq(prompts.archived, false))
      .orderBy(desc(prompts.createdAt))

    return {data: list}
  })
  .get('/api/prompts/archived', async () => {
    const db = getDatabase()
    const list = await db
      .select(promptsListSelection)
      .from(prompts)
      .where(eq(prompts.archived, true))
      .orderBy(desc(prompts.createdAt))

    return {data: list}
  })
  .patch(
    '/api/prompts/:id',
    async ({params, body, set, request}) => {
      // Get session directly (consistent with other routes like NvidiaSmiRoutes, ParquetRoutes)
      const session = await auth.api.getSession({headers: request.headers})
      const userId = session?.user?.id ?? null
      const userRole = session?.user?.role ?? null

      if (!userId) {
        set.status = 401
        return {data: null, error: 'You must be signed in'}
      }

      const db = getDatabase()
      const [existingPrompt] = await db
        .select({id: prompts.id, ownerId: prompts.ownerId})
        .from(prompts)
        .where(eq(prompts.id, params.id))
        .limit(1)

      if (!existingPrompt) {
        set.status = 404
        return {data: null, error: 'Prompt not found'}
      }

      const isAllowed = userRole === 'admin' || existingPrompt.ownerId === userId
      if (!isAllowed) {
        set.status = 403
        return {data: null, error: 'You are not allowed to update this prompt'}
      }

      const [updatedPrompt] = await db
        .update(prompts)
        .set({archived: body.archived})
        .where(eq(prompts.id, params.id))
        .returning(promptsListSelection)

      return {data: updatedPrompt ?? null}
    },
    {body: t.Object({archived: t.Boolean()})},
  )

const promptsAdminRoutes = new Elysia()
  .use(requireAdminAuth())
  .get('/api/prompts/duplicates', async () => {
    const db = getDatabase()
    const allPrompts = await db.select().from(prompts)

    // Group by content
    const groups = new Map<string, typeof allPrompts>()
    for (const p of allPrompts) {
      // Create a key based on content fields
      const key = JSON.stringify({originalText: p.originalText, promptHeading: p.promptHeading, type: p.type})

      const group = groups.get(key)
      if (group) {
        group.push(p)
      } else {
        groups.set(key, [p])
      }
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
  .post('/api/prompts/regenerate-hashes', async () => {
    const db = getDatabase()
    const promptRows = await db
      .select({
        id: prompts.id,
        originalText: prompts.originalText,
        transformedText: prompts.transformedText,
        promptHeading: prompts.promptHeading,
        type: prompts.type,
      })
      .from(prompts)

    const hashed = withHashes(promptRows)
    const groups = groupCollisions(hashed)
    const collisions = getCollisions(groups)
    const updates = safeUpdates(hashed, collisions)
    const updatedCount = await applyHashUpdates(db, updates)

    return {success: true, data: {updatedCount, skippedCollisions: collisions}}
  })
  .delete('/api/prompts/:id', async ({params}) => {
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
  .get('/api/prompts/orphans', async () => {
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
    '/api/prompts/merge',
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
  .get('/api/prompts/invalid-judgments', async () => {
    const db = getDatabase()

    // Get prompts with enum types (containing quotes like 'yes' | 'no' | 'unsure')
    const promptsWithTypes = await db
      .select({id: prompts.id, promptHeading: prompts.promptHeading, type: prompts.type})
      .from(prompts)
      .where(sql`${prompts.type} IS NOT NULL AND ${prompts.type} != ''`)

    // Parse enum options from prompt types
    const parseEnumOptions = (typeStr: string): string[] | null => {
      // Match quoted strings like 'yes' | 'no' | 'unsure'
      if (!typeStr.includes("'") && !typeStr.includes('"')) return null
      const matches = typeStr.match(/['"]([^'"]+)['"]/g)
      if (!matches || matches.length === 0) return null
      return matches.map((m) => {
        return m.slice(1, -1)
      }) // Remove quotes
    }

    const invalidJudgments: Array<{
      id: string
      articleId: string
      promptId: string
      promptHeading: string | null
      promptType: string | null
      answeredOriginal: string | null
      answeredOriginalAsArray: string[] | null
      createdAt: Date
    }> = []

    // Check each prompt with an enum type
    for (const prompt of promptsWithTypes) {
      if (!prompt.type) continue
      const validOptions = parseEnumOptions(prompt.type)
      if (!validOptions) continue // Skip if not an enum type

      // Find judgments for this prompt where the answer is not in the valid options
      // Include answeredOriginalAsArray for proper validation
      const judgmentRows = await db
        .select({
          id: judgments.id,
          articleId: judgments.articleId,
          promptId: judgments.promptId,
          answeredOriginal: judgments.answeredOriginal,
          answeredOriginalAsArray: judgments.answeredOriginalAsArray,
          createdAt: judgments.createdAt,
        })
        .from(judgments)
        .where(
          and(
            eq(judgments.promptId, prompt.id),
            // Check if either answeredOriginal OR answeredOriginalAsArray is present
            sql`(${judgments.answeredOriginal} IS NOT NULL OR ${judgments.answeredOriginalAsArray} IS NOT NULL)`,
            sql`${judgments.isAnswered} = true`,
          ),
        )
        .limit(200) // Get more than 100 to account for valid ones

      for (const judgment of judgmentRows) {
        if (invalidJudgments.length >= 100) break

        let isValid = false

        // If answeredOriginalAsArray is not null, validate against that array
        // (the prompt type expects array values in this case)
        if (judgment.answeredOriginalAsArray !== null) {
          // Validate each item in the array against valid options
          isValid = judgment.answeredOriginalAsArray.every((item) => {
            return validOptions.includes(item)
          })
        } else if (judgment.answeredOriginal) {
          // Fall back to answeredOriginal for single-value prompts
          const answer = judgment.answeredOriginal

          // Handle legacy array answers stored as JSON strings in answeredOriginal
          if (answer.startsWith('[')) {
            try {
              const parsed = JSON.parse(answer) as unknown
              if (Array.isArray(parsed)) {
                isValid = parsed.every((item) => {
                  return typeof item === 'string' && validOptions.includes(item)
                })
              }
            } catch {
              isValid = false
            }
          } else {
            isValid = validOptions.includes(answer)
          }
        }

        if (!isValid) {
          invalidJudgments.push({
            id: judgment.id,
            articleId: judgment.articleId,
            promptId: judgment.promptId,
            promptHeading: prompt.promptHeading,
            promptType: prompt.type,
            answeredOriginal: judgment.answeredOriginal,
            answeredOriginalAsArray: judgment.answeredOriginalAsArray,
            createdAt: judgment.createdAt,
          })
        }
      }

      if (invalidJudgments.length >= 100) break
    }

    return {success: true, data: invalidJudgments}
  })
  .post(
    '/api/prompts/delete-invalid-judgments',
    async ({body}) => {
      const db = getDatabase()
      const {judgmentIds} = body

      if (judgmentIds.length === 0) {
        return {success: true, data: {deletedCount: 0}}
      }

      await db.delete(judgments).where(
        sql`${judgments.id} = ANY(ARRAY[${sql.join(
          judgmentIds.map((id) => {
            return sql`${id}::uuid`
          }),
          sql`,`,
        )}])`,
      )

      return {success: true, data: {deletedCount: judgmentIds.length}}
    },
    {body: t.Object({judgmentIds: t.Array(t.String())})},
  )

export const promptsRoutes = new Elysia().use(promptsUserRoutes).use(promptsAdminRoutes)
