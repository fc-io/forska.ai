import {getSqlLiteral} from '../../services/appQueryHelpers.ts'
import {comparisonProjectTable} from './comparisonProjectRouteConstants.ts'
import type {AppQueryRunner, AppTx, ComparisonProjectRecordRow} from './comparisonProjectRouteTypes.ts'
import {getRequiredDateValue, getStringArrayRowValue} from './comparisonProjectValueHelpers.ts'

export const getComparisonProjectRecordValue = (row: ComparisonProjectRecordRow) => {
  return {
    ...row,
    modelIds: getStringArrayRowValue(row, 'modelIds'),
    humanJudgmentMode: row.humanJudgmentMode ?? 'prompt',
    createdAt: getRequiredDateValue(row.createdAt),
    updatedAt: getRequiredDateValue(row.updatedAt),
  }
}

const getComparisonProjectRecordSql = (comparisonProjectId: string) => {
  return `
    SELECT
      id,
      name,
      description,
      model_ids AS modelIds,
      compare_with_humans AS compareWithHumans,
      COALESCE(allow_conflict_resolution, FALSE) AS allowConflictResolution,
      human_judgment_mode AS humanJudgmentMode,
      summary_source_project_id AS summarySourceProjectId,
      use_title AS useTitle,
      use_abstract AS useAbstract,
      use_fulltext AS useFulltext,
      use_fulltext_no_images AS useFulltextNoImages,
      archived,
      created_at AS createdAt,
      updated_at AS updatedAt
    FROM ${comparisonProjectTable}
    WHERE id = ${getSqlLiteral(comparisonProjectId)}
    LIMIT 1
  `
}

export const getComparisonProjectRecord = async (db: AppQueryRunner, comparisonProjectId: string) => {
  const [comparisonProjectRow] = await db.queryJson<ComparisonProjectRecordRow>(
    getComparisonProjectRecordSql(comparisonProjectId),
  )
  return comparisonProjectRow ?? null
}

export const updateComparisonProjectTx = async (
  tx: AppTx,
  params: {comparisonProjectId: string; setParts: string[]},
) => {
  await tx.run(`
    UPDATE ${comparisonProjectTable}
    SET ${params.setParts.join(', ')}
    WHERE id = ${getSqlLiteral(params.comparisonProjectId)}
  `)

  return getComparisonProjectRecord(tx, params.comparisonProjectId)
}
