import {escapeSqlString} from '../../../services/appQueryHelpers.ts'
import {getComparisonProjectServingRebuildService} from '../../../services/comparisonProjectServingRebuildService.ts'
import type {AppQueryRunner, AppTx} from '../appTx.ts'

const getComparisonProjectIdsAffectedByProjectPromptEdit = async (db: AppQueryRunner, projectId: string) => {
  return db.queryJson<{comparisonProjectId: string}>(`
    SELECT DISTINCT comparison_project.id AS comparisonProjectId
    FROM app.comparison_project comparison_project
    LEFT JOIN app.comparison_project_source_project source_project
      ON source_project.comparison_project_id = comparison_project.id
     AND source_project.source_project_id = '${escapeSqlString(projectId)}'
    WHERE comparison_project.archived = FALSE
      AND (
        source_project.id IS NOT NULL
        OR comparison_project.summary_source_project_id = '${escapeSqlString(projectId)}'
      )
  `)
}

export const markComparisonServingStaleForProjectPromptEditTx = async (tx: AppTx, projectId: string) => {
  const comparisonProjectRows = await getComparisonProjectIdsAffectedByProjectPromptEdit(tx, projectId)
  await getComparisonProjectServingRebuildService().markComparisonProjectsServingStaleTx(
    comparisonProjectRows.map((row) => {
      return row.comparisonProjectId
    }),
    tx,
  )
}
