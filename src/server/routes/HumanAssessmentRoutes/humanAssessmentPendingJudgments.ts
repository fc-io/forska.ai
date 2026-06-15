import {appendHumanJudgmentReviewServingDeltas} from '../../reviewServing/humanJudgmentReviewServingDeltaService.ts'
import {getAppDatabaseService} from '../../services/appDatabaseService.ts'
import {escapeSqlString, getQuotedStringList} from '../../services/appQueryHelpers.ts'

type HumanAssessmentPromptRef = {id: string}
type PendingHumanJudgmentRow = {id: string; isAnswered: boolean; promptId: string}
export type SyncedPendingHumanJudgment = {id: string; promptId: string}

export const syncPendingHumanJudgmentsForArticle = async (params: {
  articleId: string
  projectId: string
  prompts: HumanAssessmentPromptRef[]
}): Promise<SyncedPendingHumanJudgment[]> => {
  const promptIds = params.prompts.map((prompt) => {
    return prompt.id
  })

  return getAppDatabaseService().transaction(async (tx) => {
    if (promptIds.length === 0) {
      await tx.run(`
        DELETE FROM app.judgment_human
        WHERE project_id = '${escapeSqlString(params.projectId)}'
          AND article_id = '${escapeSqlString(params.articleId)}'
          AND is_answered = FALSE
      `)

      return []
    }

    const promptIdList = getQuotedStringList(promptIds).join(', ')

    await tx.run(`
      DELETE FROM app.judgment_human
      WHERE project_id = '${escapeSqlString(params.projectId)}'
        AND article_id = '${escapeSqlString(params.articleId)}'
        AND is_answered = FALSE
        AND prompt_id NOT IN (${promptIdList})
    `)

    const existingRows = await tx.queryJson<PendingHumanJudgmentRow>(`
      SELECT id, prompt_id AS promptId, is_answered AS isAnswered
      FROM app.judgment_human
      WHERE project_id = '${escapeSqlString(params.projectId)}'
        AND article_id = '${escapeSqlString(params.articleId)}'
        AND prompt_id IN (${promptIdList})
    `)
    const existingPromptIds = new Set(
      existingRows.map((row) => {
        return row.promptId
      }),
    )
    const missingPrompts = params.prompts.filter((prompt) => {
      return !existingPromptIds.has(prompt.id)
    })
    const insertedRows =
      missingPrompts.length === 0
        ? []
        : await tx.queryJson<PendingHumanJudgmentRow>(`
            INSERT INTO app.judgment_human (id, article_id, prompt_id, project_id, is_answered, answer, comment)
            VALUES ${missingPrompts
              .map((prompt) => {
                return `(${getQuotedStringList([crypto.randomUUID(), params.articleId, prompt.id, params.projectId]).join(', ')}, FALSE, NULL, NULL)`
              })
              .join(', ')}
            RETURNING id, prompt_id AS promptId, is_answered AS isAnswered
          `)
    await appendHumanJudgmentReviewServingDeltas(
      tx,
      insertedRows.map((row) => {
        return {
          answer: null,
          articleId: params.articleId,
          humanJudgmentKey: row.id,
          projectId: params.projectId,
          promptId: row.promptId,
          sourceMutationKey: `syncPendingHumanJudgments|${params.projectId}|${params.articleId}|${row.promptId}|${row.id}`,
          sourceOperation: 'insert' as const,
          sourceTable: 'app.judgment_human',
        }
      }),
    )
    const pendingRowsByPromptId = new Map(
      [...existingRows, ...insertedRows]
        .filter((row) => {
          return !row.isAnswered
        })
        .map((row) => {
          return [row.promptId, {id: row.id, promptId: row.promptId}]
        }),
    )

    return params.prompts.flatMap((prompt) => {
      const pendingRow = pendingRowsByPromptId.get(prompt.id)
      return pendingRow ? [pendingRow] : []
    })
  })
}
