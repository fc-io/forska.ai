import {escapeSqlString} from '../../../services/appQueryHelpers.ts'
import type {PromptMergeTransaction} from './promptMergeTransaction.ts'

type JudgmentHumanPromptCollisionRow = {id: string}

export const resolveJudgmentHumanPromptCollisions = async ({
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
