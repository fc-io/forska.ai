import {escapeSqlString, getQuotedStringList} from '../../../services/appQueryHelpers.ts'
import type {AppTx} from '../appTx.ts'
import {getUniqueSortedStrings} from './getUniqueSortedStrings.ts'
import type {ChangedProjectPromptLink} from './projectEditTypes.ts'

export const deleteProjectHumanPromptAnswersForChangedPromptLinksTx = async (
  tx: AppTx,
  params: {changedPromptLinks: ChangedProjectPromptLink[]; projectId: string},
) => {
  const oldPromptIds = getUniqueSortedStrings(
    params.changedPromptLinks.map((link) => {
      return link.oldPromptId
    }),
  )

  if (oldPromptIds.length === 0) {
    return 0
  }

  const oldPromptIdList = getQuotedStringList(oldPromptIds).join(', ')
  const [countRow] = await tx.queryJson<{count: number}>(`
    SELECT COUNT(*) AS count
    FROM app.judgment_human
    WHERE project_id = '${escapeSqlString(params.projectId)}'
      AND prompt_id IN (${oldPromptIdList})
  `)

  await tx.run(`
    DELETE FROM app.judgment_human
    WHERE project_id = '${escapeSqlString(params.projectId)}'
      AND prompt_id IN (${oldPromptIdList})
  `)

  return Number(countRow?.count ?? 0)
}
