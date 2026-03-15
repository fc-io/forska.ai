import {Elysia, t} from 'elysia'

import {prompts} from '../../db/schema'
import {getAppDatabaseService} from '../services/appDatabaseService'
import {
  escapeSqlString,
  getDateValue,
  getJsonValue,
  getQuotedStringList,
  getSqlLiteral,
} from '../services/appQueryHelpers'
import {computePromptContentHash} from '../utils/computePromptContentHash'
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

const applyHashUpdates = async (updates: PromptHashUpdate[]) => {
  if (updates.length === 0) {
    return 0
  }

  await Promise.all(
    updates.map((update) => {
      return getAppDatabaseService().run(`
        UPDATE app.prompt
        SET content_hash = ${getSqlLiteral(update.hash)},
            updated_at = current_timestamp
        WHERE id = '${escapeSqlString(update.id)}'
      `)
    }),
  )

  return updates.length
}

const normalizePromptListRow = <TRow extends Record<string, unknown>>(row: TRow) => {
  return {...row, createdAt: getDateValue(row['createdAt']), updatedAt: getDateValue(row['updatedAt'])}
}

const promptsUserRoutes = new Elysia()
  .use(withErrorHandler())
  .get('/api/prompts', async () => {
    const list = await getAppDatabaseService().queryJson<{
      id: string
      originalText: string
      promptHeading: string | null
      type: string | null
      createdAt: unknown
      updatedAt: unknown
      archived: boolean
    }>(`
      SELECT
        id,
        original_text AS originalText,
        prompt_heading AS promptHeading,
        type,
        created_at AS createdAt,
        updated_at AS updatedAt,
        archived
      FROM app.prompt
      WHERE archived = FALSE
      ORDER BY created_at DESC
    `)

    return {data: list.map(normalizePromptListRow)}
  })
  .get('/api/prompts/archived', async () => {
    const list = await getAppDatabaseService().queryJson<{
      id: string
      originalText: string
      promptHeading: string | null
      type: string | null
      createdAt: unknown
      updatedAt: unknown
      archived: boolean
    }>(`
      SELECT
        id,
        original_text AS originalText,
        prompt_heading AS promptHeading,
        type,
        created_at AS createdAt,
        updated_at AS updatedAt,
        archived
      FROM app.prompt
      WHERE archived = TRUE
      ORDER BY created_at DESC
    `)

    return {data: list.map(normalizePromptListRow)}
  })
  .patch(
    '/api/prompts/:id',
    async ({params, body, set}) => {
      const [existingPrompt] = await getAppDatabaseService().queryJson<{id: string}>(`
        SELECT id
        FROM app.prompt
        WHERE id = '${escapeSqlString(params.id)}'
        LIMIT 1
      `)

      if (!existingPrompt) {
        set.status = 404
        return {data: null, error: 'Prompt not found'}
      }

      const [updatedPrompt] = await getAppDatabaseService().queryJson<{
        id: string
        originalText: string
        promptHeading: string | null
        type: string | null
        createdAt: unknown
        updatedAt: unknown
        archived: boolean
      }>(`
        UPDATE app.prompt
        SET archived = ${body.archived ? 'TRUE' : 'FALSE'},
            updated_at = current_timestamp
        WHERE id = '${escapeSqlString(params.id)}'
        RETURNING
          id,
          original_text AS originalText,
          prompt_heading AS promptHeading,
          type,
          created_at AS createdAt,
          updated_at AS updatedAt,
          archived
      `)

      return {data: updatedPrompt ? normalizePromptListRow(updatedPrompt) : null}
    },
    {body: t.Object({archived: t.Boolean()})},
  )

const promptsAdminRoutes = new Elysia()
  .get('/api/prompts/duplicates', async () => {
    const allPrompts = await getAppDatabaseService().queryJson<
      PromptRow & {archived: boolean; createdAt: unknown; updatedAt: unknown}
    >(`
      SELECT
        id,
        original_text AS originalText,
        transformed_text AS transformedText,
        prompt_heading AS promptHeading,
        type,
        archived,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM app.prompt
    `)

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
            const [[projectCount], [judgmentCount], [humanJudgmentCount], projects] = await Promise.all([
              getAppDatabaseService().queryJson<{count: number}>(`
                SELECT COUNT(*) AS count
                FROM app.project_prompt
                WHERE prompt_id = '${escapeSqlString(p.id)}'
              `),
              getAppDatabaseService().queryJson<{count: number}>(`
                SELECT COUNT(*) AS count
                FROM app.judgment
                WHERE prompt_id = '${escapeSqlString(p.id)}'
              `),
              getAppDatabaseService().queryJson<{count: number}>(`
                SELECT COUNT(*) AS count
                FROM app.judgment_human
                WHERE prompt_id = '${escapeSqlString(p.id)}'
              `),
              getAppDatabaseService().queryJson<{id: string}>(`
                SELECT project_id AS id
                FROM app.project_prompt
                WHERE prompt_id = '${escapeSqlString(p.id)}'
              `),
            ])

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
    const promptRows = await getAppDatabaseService().queryJson<PromptRow>(`
      SELECT
        id,
        original_text AS originalText,
        transformed_text AS transformedText,
        prompt_heading AS promptHeading,
        type
      FROM app.prompt
    `)

    const hashed = withHashes(promptRows)
    const groups = groupCollisions(hashed)
    const collisions = getCollisions(groups)
    const updates = safeUpdates(hashed, collisions)
    const updatedCount = await applyHashUpdates(updates)

    return {success: true, data: {updatedCount, skippedCollisions: collisions}}
  })
  .delete('/api/prompts/:id', async ({params}) => {
    const {id} = params

    // Strict verification: Ensure no connections exist
    const [[projectCount], [judgmentCount], [humanJudgmentCount]] = await Promise.all([
      getAppDatabaseService().queryJson<{count: number}>(`
        SELECT COUNT(*) AS count
        FROM app.project_prompt
        WHERE prompt_id = '${escapeSqlString(id)}'
      `),
      getAppDatabaseService().queryJson<{count: number}>(`
        SELECT COUNT(*) AS count
        FROM app.judgment
        WHERE prompt_id = '${escapeSqlString(id)}'
      `),
      getAppDatabaseService().queryJson<{count: number}>(`
        SELECT COUNT(*) AS count
        FROM app.judgment_human
        WHERE prompt_id = '${escapeSqlString(id)}'
      `),
    ])

    if ((projectCount?.count ?? 0) > 0 || (judgmentCount?.count ?? 0) > 0 || (humanJudgmentCount?.count ?? 0) > 0) {
      throw new Error('Prompt is not fully orphaned. It has existing connections.')
    }

    await getAppDatabaseService().run(`
      DELETE FROM app.prompt
      WHERE id = '${escapeSqlString(id)}'
    `)

    return {success: true}
  })
  .get('/api/prompts/orphans', async () => {
    const [noProjects, noJudgments, noProjectsAndJudgments] = await Promise.all([
      getAppDatabaseService().queryJson<{
        id: string
        originalText: string
        promptHeading: string | null
        type: string | null
        createdAt: unknown
      }>(`
        SELECT id, original_text AS originalText, prompt_heading AS promptHeading, type, created_at AS createdAt
        FROM app.prompt p
        WHERE NOT EXISTS (
          SELECT 1 FROM app.project_prompt pp WHERE pp.prompt_id = p.id LIMIT 1
        )
      `),
      getAppDatabaseService().queryJson<{
        id: string
        originalText: string
        promptHeading: string | null
        type: string | null
        createdAt: unknown
      }>(`
        SELECT id, original_text AS originalText, prompt_heading AS promptHeading, type, created_at AS createdAt
        FROM app.prompt p
        WHERE NOT EXISTS (SELECT 1 FROM app.judgment j WHERE j.prompt_id = p.id LIMIT 1)
          AND NOT EXISTS (SELECT 1 FROM app.judgment_human jh WHERE jh.prompt_id = p.id LIMIT 1)
      `),
      getAppDatabaseService().queryJson<{
        id: string
        originalText: string
        promptHeading: string | null
        type: string | null
        createdAt: unknown
      }>(`
        SELECT id, original_text AS originalText, prompt_heading AS promptHeading, type, created_at AS createdAt
        FROM app.prompt p
        WHERE NOT EXISTS (SELECT 1 FROM app.project_prompt pp WHERE pp.prompt_id = p.id LIMIT 1)
          AND NOT EXISTS (SELECT 1 FROM app.judgment j WHERE j.prompt_id = p.id LIMIT 1)
          AND NOT EXISTS (SELECT 1 FROM app.judgment_human jh WHERE jh.prompt_id = p.id LIMIT 1)
      `),
    ])

    const normalizeRows = <TRow extends {createdAt: unknown}>(rows: TRow[]) => {
      return rows.map((row) => {
        return {...row, createdAt: getDateValue(row.createdAt)}
      })
    }

    return {
      success: true,
      data: {
        noProjects: normalizeRows(noProjects),
        noJudgments: normalizeRows(noJudgments),
        noProjectsAndJudgments: normalizeRows(noProjectsAndJudgments),
      },
    }
  })
  .post(
    '/api/prompts/merge',
    async ({body}) => {
      const {keepPromptId, mergePromptIds} = body
      await getAppDatabaseService().transaction(async (tx) => {
        for (const mergeId of mergePromptIds) {
          // 1. Handle Project Prompts
          const projectsUsingMerge = await tx.queryJson<{projectId: string}>(`
            SELECT project_id AS projectId
            FROM app.project_prompt
            WHERE prompt_id = '${escapeSqlString(mergeId)}'
          `)

          for (const p of projectsUsingMerge) {
            // Check if project already uses keepId
            const existing = await tx.queryJson<{id: string}>(`
              SELECT id
              FROM app.project_prompt
              WHERE project_id = '${escapeSqlString(p.projectId)}'
                AND prompt_id = '${escapeSqlString(keepPromptId)}'
            `)

            if (existing.length > 0) {
              // Project already has the target prompt, so just remove the duplicate link
              await tx.run(`
                DELETE FROM app.project_prompt
                WHERE project_id = '${escapeSqlString(p.projectId)}'
                  AND prompt_id = '${escapeSqlString(mergeId)}'
              `)
            } else {
              // Project doesn't have the target prompt, so update the link
              await tx.run(`
                UPDATE app.project_prompt
                SET prompt_id = '${escapeSqlString(keepPromptId)}',
                    updated_at = current_timestamp
                WHERE project_id = '${escapeSqlString(p.projectId)}'
                  AND prompt_id = '${escapeSqlString(mergeId)}'
              `)
            }
          }

          // 2. Handle Judgments
          await tx.run(`
            UPDATE app.judgment
            SET prompt_id = '${escapeSqlString(keepPromptId)}',
                updated_at = current_timestamp
            WHERE prompt_id = '${escapeSqlString(mergeId)}'
          `)

          // 3. Handle Human Judgments
          await tx.run(`
            UPDATE app.judgment_human
            SET prompt_id = '${escapeSqlString(keepPromptId)}',
                updated_at = current_timestamp
            WHERE prompt_id = '${escapeSqlString(mergeId)}'
          `)

          // 4. Delete the merged prompt
          await tx.run(`
            DELETE FROM app.prompt
            WHERE id = '${escapeSqlString(mergeId)}'
          `)
        }
      })

      return {success: true}
    },
    {body: t.Object({keepPromptId: t.String(), mergePromptIds: t.Array(t.String())})},
  )
  .get('/api/prompts/invalid-judgments', async () => {
    // Get prompts with enum types (containing quotes like 'yes' | 'no' | 'unsure')
    const promptsWithTypes = await getAppDatabaseService().queryJson<{
      id: string
      promptHeading: string | null
      type: string | null
    }>(`
      SELECT id, prompt_heading AS promptHeading, type
      FROM app.prompt
      WHERE type IS NOT NULL
        AND type != ''
    `)

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
      const judgmentRows = await getAppDatabaseService().queryJson<{
        id: string
        articleId: string
        promptId: string
        answeredOriginal: string | null
        answeredOriginalAsArray: unknown
        createdAt: unknown
      }>(`
        SELECT
          id,
          article_id AS articleId,
          prompt_id AS promptId,
          answered_original AS answeredOriginal,
          TO_JSON(answered_original_as_array) AS answeredOriginalAsArray,
          created_at AS createdAt
        FROM app.judgment
        WHERE prompt_id = '${escapeSqlString(prompt.id)}'
          AND (answered_original IS NOT NULL OR answered_original_as_array IS NOT NULL)
          AND is_answered = TRUE
        LIMIT 200
      `)

      for (const judgment of judgmentRows) {
        if (invalidJudgments.length >= 100) break

        let isValid = false

        // If answeredOriginalAsArray is not null, validate against that array
        // (the prompt type expects array values in this case)
        const answeredOriginalAsArray = getJsonValue(judgment.answeredOriginalAsArray)
        if (answeredOriginalAsArray !== null) {
          // Validate each item in the array against valid options
          isValid =
            Array.isArray(answeredOriginalAsArray)
            && answeredOriginalAsArray.every((item) => {
              return typeof item === 'string' && validOptions.includes(item)
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
            answeredOriginalAsArray: Array.isArray(answeredOriginalAsArray) ? answeredOriginalAsArray : null,
            createdAt: getDateValue(judgment.createdAt) ?? new Date(0),
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
      const {judgmentIds} = body

      if (judgmentIds.length === 0) {
        return {success: true, data: {deletedCount: 0}}
      }

      const now = new Date()

      await getAppDatabaseService().run(`
        UPDATE app.judgment
        SET deleted_at = ${getSqlLiteral(now)},
            updated_at = ${getSqlLiteral(now)}
        WHERE id IN (${getQuotedStringList(judgmentIds).join(', ')})
      `)

      return {success: true, data: {deletedCount: judgmentIds.length}}
    },
    {body: t.Object({judgmentIds: t.Array(t.String())})},
  )

export const promptsRoutes = new Elysia().use(promptsUserRoutes).use(promptsAdminRoutes)
