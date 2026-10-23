import {appendHumanJudgmentReviewServingDeltas} from '../../reviewServing/humanJudgmentReviewServingDeltaService.ts'
import {
  appendProjectReviewConfigReviewServingDeltas,
  appendPromptConfigReviewServingDeltas,
} from '../../reviewServing/reviewConfigReviewServingDeltaService.ts'
import {getAppDatabaseService} from '../../services/appDatabaseService.ts'
import {escapeSqlString, getDateValue, getQuotedStringList, getSqlLiteral} from '../../services/appQueryHelpers.ts'
import {immutablePromptIdentityReviewServingFields} from '../../services/immutablePromptService.ts'
import {resolveJudgmentHumanPromptCollisions} from './promptsRoutesPostMerge/resolveJudgmentHumanPromptCollisions.ts'
import {resolveJudgmentPromptCollisions} from './promptsRoutesPostMerge/resolveJudgmentPromptCollisions.ts'

type JudgmentHumanPromptMoveRow = {
  answer: string | null
  articleId: string
  id: string
  projectId: string
  updatedAt: string | null
}

export const promptsRoutesPostMerge = async ({body}: {body: {keepPromptId: string; mergePromptIds: string[]}}) => {
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
              AND is_answered = TRUE
              AND answer IS NOT NULL
              AND TRIM(answer) <> ''
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
}
