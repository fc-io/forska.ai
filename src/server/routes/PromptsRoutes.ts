import {Elysia, t} from 'elysia'

import type {PromptRecord} from '../../db/schemaTypes.ts'
import {appendHumanJudgmentReviewServingDeltas} from '../reviewServing/humanJudgmentReviewServingDeltaService.ts'
import {appendLlmJudgmentReviewServingDeltas} from '../reviewServing/llmJudgmentReviewServingDeltaService.ts'
import {
  appendProjectReviewConfigReviewServingDeltas,
  appendPromptConfigReviewServingDeltas,
} from '../reviewServing/reviewConfigReviewServingDeltaService.ts'
import {getAppDatabaseService} from '../services/appDatabaseService'
import {
  escapeSqlString,
  getDateValue,
  getJsonValue,
  getQuotedStringList,
  getSqlLiteral,
} from '../services/appQueryHelpers'
import {immutablePromptIdentityReviewServingFields} from '../services/immutablePromptService.ts'
import {getProjectMartDirtyRefreshStateService} from '../services/projectMartDirtyRefreshStateService.ts'
import {computePromptContentHash} from '../utils/computePromptContentHash'
import {withErrorHandler} from '../utils/routeErrorHandler'
import {promptsReadOnlyRoutes} from './promptsRoutes/promptsRoutesReadOnly.ts'

type PromptRow = Pick<PromptRecord, 'id' | 'originalText' | 'transformedText' | 'promptHeading' | 'type'>

type PromptCollision = {hash: string; promptIds: string[]}
type PromptHashUpdate = {id: string; hash: string}
type PromptReferenceCounts = {
  comparisonProjectCount: number
  humanJudgmentCount: number
  judgmentCount: number
  projectCount: number
}
type PromptMergeTransaction = {
  queryJson: <TRow>(statement: string) => Promise<TRow[]>
  run: (statement: string) => Promise<void>
}
type JudgmentPromptCollisionRow = {
  articleId: string
  keepJudgmentId: string
  mergeJudgmentId: string
  modelId: string
  projectId: string | null
  promptId: string
  updatedAt: string | null
  useAbstract: boolean
  useFulltext: boolean
  useFulltextNoImages: boolean
  useTitle: boolean
}
type JudgmentHumanPromptMoveRow = {
  answer: string | null
  articleId: string
  id: string
  projectId: string
  updatedAt: string | null
}
type JudgmentAssessmentRow = {id: string}
type JudgmentHumanPromptCollisionRow = {id: string}

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

const getPromptReferenceCounts = async (id: string): Promise<PromptReferenceCounts> => {
  const [[projectCount], [comparisonProjectCount], [judgmentCount], [humanJudgmentCount]] = await Promise.all([
    getAppDatabaseService().queryJson<{count: number}>(`
      SELECT COUNT(*) AS count
      FROM app.project_prompt
      WHERE prompt_id = '${escapeSqlString(id)}'
    `),
    getAppDatabaseService().queryJson<{count: number}>(`
      SELECT COUNT(*) AS count
      FROM app.comparison_project_prompt
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

  return {
    projectCount: Number(projectCount?.count ?? 0),
    comparisonProjectCount: Number(comparisonProjectCount?.count ?? 0),
    judgmentCount: Number(judgmentCount?.count ?? 0),
    humanJudgmentCount: Number(humanJudgmentCount?.count ?? 0),
  }
}

const hasPromptReferences = ({
  comparisonProjectCount,
  humanJudgmentCount,
  judgmentCount,
  projectCount,
}: PromptReferenceCounts) => {
  return projectCount > 0 || comparisonProjectCount > 0 || judgmentCount > 0 || humanJudgmentCount > 0
}

const getJudgmentPromptCollisions = async ({
  keepPromptId,
  mergeId,
  tx,
}: {
  keepPromptId: string
  mergeId: string
  tx: PromptMergeTransaction
}) => {
  return tx.queryJson<JudgmentPromptCollisionRow>(`
    SELECT keep_row.id AS keepJudgmentId,
           merge_row.id AS mergeJudgmentId,
           merge_row.article_id AS articleId,
           merge_row.model_id AS modelId,
           merge_row.project_id AS projectId,
           merge_row.prompt_id AS promptId,
           merge_row.updated_at AS updatedAt,
           merge_row.use_abstract AS useAbstract,
           merge_row.use_fulltext AS useFulltext,
           merge_row.use_fulltext_no_images AS useFulltextNoImages,
           merge_row.use_title AS useTitle
    FROM app.judgment merge_row
    INNER JOIN app.judgment keep_row
      ON keep_row.article_id = merge_row.article_id
     AND keep_row.prompt_id = '${escapeSqlString(keepPromptId)}'
     AND keep_row.model_id = merge_row.model_id
     AND keep_row.use_title = merge_row.use_title
     AND keep_row.use_abstract = merge_row.use_abstract
     AND keep_row.use_fulltext = merge_row.use_fulltext
     AND keep_row.use_fulltext_no_images = merge_row.use_fulltext_no_images
     AND keep_row.delete_generation = merge_row.delete_generation
    WHERE merge_row.prompt_id = '${escapeSqlString(mergeId)}'
  `)
}

const moveJudgmentAssessmentToKeptJudgment = async ({
  keepJudgmentId,
  mergeJudgmentId,
  tx,
}: {
  keepJudgmentId: string
  mergeJudgmentId: string
  tx: PromptMergeTransaction
}) => {
  const [keepAssessment, mergeAssessment] = await Promise.all([
    tx.queryJson<JudgmentAssessmentRow>(`
      SELECT id
      FROM app.judgment_assessment
      WHERE judgment_id = '${escapeSqlString(keepJudgmentId)}'
      LIMIT 1
    `),
    tx.queryJson<JudgmentAssessmentRow>(`
      SELECT id
      FROM app.judgment_assessment
      WHERE judgment_id = '${escapeSqlString(mergeJudgmentId)}'
      LIMIT 1
    `),
  ])

  const mergeAssessmentRow = mergeAssessment.at(0)

  if (!mergeAssessmentRow) {
    return
  }

  const {id: mergeAssessmentId} = mergeAssessmentRow

  if (keepAssessment.length > 0) {
    await tx.run(`
      DELETE FROM app.judgment_assessment
      WHERE id = '${escapeSqlString(mergeAssessmentId)}'
    `)
    return
  }

  await tx.run(`
    UPDATE app.judgment_assessment
    SET judgment_id = '${escapeSqlString(keepJudgmentId)}',
        updated_at = current_timestamp
    WHERE id = '${escapeSqlString(mergeAssessmentId)}'
  `)
}

const resolveJudgmentPromptCollisions = async ({
  affectedProjectIds,
  keepPromptId,
  mergeId,
  tx,
}: {
  affectedProjectIds: string[]
  keepPromptId: string
  mergeId: string
  tx: PromptMergeTransaction
}) => {
  const collisions = await getJudgmentPromptCollisions({keepPromptId, mergeId, tx})

  for (const collision of collisions) {
    await moveJudgmentAssessmentToKeptJudgment({
      keepJudgmentId: collision.keepJudgmentId,
      mergeJudgmentId: collision.mergeJudgmentId,
      tx,
    })
    await appendLlmJudgmentReviewServingDeltas(
      tx,
      (collision.projectId ? [collision.projectId] : affectedProjectIds).map((projectId) => {
        return {
          articleId: collision.articleId,
          changeKind: 'judgment.llm.deleted',
          judgmentId: collision.mergeJudgmentId,
          modelId: collision.modelId,
          projectId,
          promptId: collision.promptId,
          sourceMutationKey: collision.projectId
            ? `promptMerge|${mergeId}|${keepPromptId}|${collision.mergeJudgmentId}`
            : `promptMerge|${mergeId}|${keepPromptId}|${collision.mergeJudgmentId}|${projectId}`,
          sourceOperation: 'delete',
          sourceUpdatedAt: collision.updatedAt,
          useAbstract: collision.useAbstract,
          useFulltext: collision.useFulltext,
          useFulltextNoImages: collision.useFulltextNoImages,
          useTitle: collision.useTitle,
        }
      }),
    )
    await tx.run(`
      DELETE FROM app.judgment
      WHERE id = '${escapeSqlString(collision.mergeJudgmentId)}'
    `)
  }
}

const resolveJudgmentHumanPromptCollisions = async ({
  keepPromptId,
  mergeId,
  tx,
}: {
  keepPromptId: string
  mergeId: string
  tx: PromptMergeTransaction
}) => {
  const collisions = await tx.queryJson<JudgmentHumanPromptCollisionRow>(`
    SELECT merge_row.id AS id
    FROM app.judgment_human merge_row
    INNER JOIN app.judgment_human keep_row
      ON keep_row.project_id = merge_row.project_id
     AND keep_row.article_id = merge_row.article_id
     AND keep_row.prompt_id = '${escapeSqlString(keepPromptId)}'
    WHERE merge_row.prompt_id = '${escapeSqlString(mergeId)}'
  `)

  for (const collision of collisions) {
    await tx.run(`
      DELETE FROM app.judgment_human
      WHERE id = '${escapeSqlString(collision.id)}'
    `)
  }
}

const promptsUserRoutes = new Elysia().use(withErrorHandler()).patch(
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

    return {
      data: updatedPrompt
        ? {
            ...updatedPrompt,
            createdAt: getDateValue(updatedPrompt.createdAt),
            updatedAt: getDateValue(updatedPrompt.updatedAt),
          }
        : null,
    }
  },
  {body: t.Object({archived: t.Boolean()})},
)

const promptsAdminRoutes = new Elysia()
  .use(withErrorHandler())
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
  .delete('/api/prompts/:id', async ({params, set}) => {
    const {id} = params

    const referenceCounts = await getPromptReferenceCounts(id)

    if (hasPromptReferences(referenceCounts)) {
      set.status = 409
      return {
        data: null,
        error: 'Prompt delete blocked. Remove project, comparison project, and judgment references first.',
      }
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
      const affectedPromptIds = [keepPromptId, ...mergePromptIds]

      await getAppDatabaseService().transaction(async (tx) => {
        const affectedProjects = await tx.queryJson<{projectId: string}>(`
          SELECT DISTINCT project_id AS projectId
          FROM app.project_prompt
          WHERE prompt_id IN (${getQuotedStringList(affectedPromptIds).join(', ')})
        `)

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

          await resolveJudgmentPromptCollisions({
            affectedProjectIds: affectedProjects.map((project) => {
              return project.projectId
            }),
            keepPromptId,
            mergeId,
            tx,
          })
          await tx.run(`
            UPDATE app.judgment
            SET prompt_id = '${escapeSqlString(keepPromptId)}',
                updated_at = current_timestamp
            WHERE prompt_id = '${escapeSqlString(mergeId)}'
          `)

          await resolveJudgmentHumanPromptCollisions({keepPromptId, mergeId, tx})
          const humanPromptMoveRows = await tx.queryJson<JudgmentHumanPromptMoveRow>(`
            SELECT id, project_id AS projectId, article_id AS articleId, answer, updated_at AS updatedAt
            FROM app.judgment_human
            WHERE prompt_id = '${escapeSqlString(mergeId)}'
          `)
          await tx.run(`
            UPDATE app.judgment_human
            SET prompt_id = '${escapeSqlString(keepPromptId)}',
                updated_at = current_timestamp
            WHERE prompt_id = '${escapeSqlString(mergeId)}'
          `)
          await appendHumanJudgmentReviewServingDeltas(
            tx,
            humanPromptMoveRows.map((row) => {
              return {
                answer: row.answer,
                articleId: row.articleId,
                humanJudgmentKey: row.id,
                projectId: row.projectId,
                promptId: keepPromptId,
                sourceMutationKey: `promptMergeHuman|${mergeId}|${keepPromptId}|${row.id}`,
                sourceOperation: 'update' as const,
                sourceTable: 'app.judgment_human',
                sourceUpdatedAt: row.updatedAt,
              }
            }),
          )

          const comparisonProjectsUsingMerge = await tx.queryJson<{
            comparisonProjectId: string
            createdAt: unknown
            id: string
            promptOrder: number | null
          }>(`
            SELECT id,
                   comparison_project_id AS comparisonProjectId,
                   prompt_order AS promptOrder,
                   created_at AS createdAt
            FROM app.comparison_project_prompt
            WHERE prompt_id = '${escapeSqlString(mergeId)}'
          `)

          for (const comparisonProject of comparisonProjectsUsingMerge) {
            const existingComparisonProjectPrompt = await tx.queryJson<{id: string}>(`
              SELECT id
              FROM app.comparison_project_prompt
              WHERE comparison_project_id = '${escapeSqlString(comparisonProject.comparisonProjectId)}'
                AND prompt_id = '${escapeSqlString(keepPromptId)}'
            `)

            if (existingComparisonProjectPrompt.length > 0) {
              await tx.run(`
                DELETE FROM app.comparison_project_prompt
                WHERE comparison_project_id = '${escapeSqlString(comparisonProject.comparisonProjectId)}'
                  AND prompt_id = '${escapeSqlString(mergeId)}'
              `)
            } else {
              await tx.run(`
                DELETE FROM app.comparison_project_prompt
                WHERE id = '${escapeSqlString(comparisonProject.id)}'
              `)
              await tx.run(`
                INSERT INTO app.comparison_project_prompt (
                  id,
                  comparison_project_id,
                  prompt_id,
                  prompt_order,
                  created_at,
                  updated_at
                ) VALUES (
                  '${escapeSqlString(comparisonProject.id)}',
                  '${escapeSqlString(comparisonProject.comparisonProjectId)}',
                  '${escapeSqlString(keepPromptId)}',
                  ${getSqlLiteral(comparisonProject.promptOrder)},
                  ${getSqlLiteral(getDateValue(comparisonProject.createdAt))},
                  current_timestamp
                )
              `)
            }
          }
        }

        await appendProjectReviewConfigReviewServingDeltas(
          tx,
          affectedProjects.map((project) => {
            return {
              changedReviewConfigFields: ['promptMembership'],
              projectId: project.projectId,
              sourceMutationKey: `promptMergeProjectReviewConfig|${keepPromptId}|${mergePromptIds.join(',')}|${project.projectId}`,
              sourceOperation: 'update' as const,
              sourceTable: 'app.project_prompt',
            }
          }),
        )
        await appendPromptConfigReviewServingDeltas(
          tx,
          affectedProjects.map((project) => {
            return {
              changedPromptConfigFields: [...immutablePromptIdentityReviewServingFields],
              projectId: project.projectId,
              promptId: keepPromptId,
              sourceMutationKey: `promptMergePromptConfig|${keepPromptId}|${mergePromptIds.join(',')}|${project.projectId}`,
              sourceOperation: 'update' as const,
              sourceTable: 'app.project_prompt',
            }
          }),
        )

        const dirtyProjects = await getProjectMartDirtyRefreshStateService().getDirtyProjectsForProjectIds(
          tx,
          affectedProjects.map((project) => {
            return project.projectId
          }),
        )

        await getProjectMartDirtyRefreshStateService().markProjectsDirtyAtomically({
          projects: dirtyProjects,
          reason: 'PromptsRoutes.merge',
          runner: tx,
        })
      })

      await getAppDatabaseService().transaction(async (tx) => {
        for (const mergeId of mergePromptIds) {
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

      await getAppDatabaseService().transaction(async (tx) => {
        const affectedJudgments = await tx.queryJson<{articleId: string}>(`
          SELECT DISTINCT article_id AS articleId
          FROM app.judgment
          WHERE id IN (${getQuotedStringList(judgmentIds).join(', ')})
        `)

        await tx.run(`
          UPDATE app.judgment
          SET deleted_at = ${getSqlLiteral(now)},
              updated_at = ${getSqlLiteral(now)}
          WHERE id IN (${getQuotedStringList(judgmentIds).join(', ')})
        `)

        await getProjectMartDirtyRefreshStateService().markArticleProjectsDirtyAtomically({
          articleIds: affectedJudgments.map((judgment) => {
            return judgment.articleId
          }),
          reason: 'PromptsRoutes.deleteInvalidJudgments',
          runner: tx,
        })
      })

      return {success: true, data: {deletedCount: judgmentIds.length}}
    },
    {body: t.Object({judgmentIds: t.Array(t.String())})},
  )

export const promptsRoutes = new Elysia()
  .use(withErrorHandler())
  .use(promptsReadOnlyRoutes)
  .use(promptsUserRoutes)
  .use(promptsAdminRoutes)
