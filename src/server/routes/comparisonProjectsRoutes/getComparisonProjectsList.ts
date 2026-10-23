import type {HumanJudgmentMode} from '../../../db/schemaTypes.ts'
import {getDateValue} from '../../services/appQueryHelpers.ts'
import {
  comparisonProjectImportRouteTable,
  comparisonProjectPromptTable,
  comparisonProjectTable,
} from './comparisonProjectRouteConstants.ts'
import {appDatabaseService} from './comparisonProjectRouteServices.ts'
import {getBooleanLiteral} from './comparisonProjectSqlClauses.ts'

export const getComparisonProjectsList = async (archived: boolean) => {
  const rows = await appDatabaseService.queryJson<{
    id: string
    name: string
    description: string | null
    compareWithHumans: boolean
    allowConflictResolution: boolean
    humanJudgmentMode: HumanJudgmentMode | null
    summarySourceProjectId: string | null
    useTitle: boolean
    useAbstract: boolean
    useFulltext: boolean
    useFulltextNoImages: boolean
    archived: boolean
    createdAt: unknown
    promptCount: number
    routeCount: number
  }>(`
    SELECT
      cp.id AS id,
      cp.name AS name,
      cp.description AS description,
      cp.compare_with_humans AS compareWithHumans,
      COALESCE(cp.allow_conflict_resolution, FALSE) AS allowConflictResolution,
      cp.human_judgment_mode AS humanJudgmentMode,
      cp.summary_source_project_id AS summarySourceProjectId,
      cp.use_title AS useTitle,
      cp.use_abstract AS useAbstract,
      cp.use_fulltext AS useFulltext,
      cp.use_fulltext_no_images AS useFulltextNoImages,
      cp.archived AS archived,
      cp.created_at AS createdAt,
      COALESCE(prompt_counts.promptCount, 0) AS promptCount,
      COALESCE(route_counts.routeCount, 0) AS routeCount
    FROM ${comparisonProjectTable} cp
    LEFT JOIN (
      SELECT comparison_project_id AS comparisonProjectId, COUNT(*) AS promptCount
      FROM ${comparisonProjectPromptTable}
      GROUP BY comparison_project_id
    ) prompt_counts ON prompt_counts.comparisonProjectId = cp.id
    LEFT JOIN (
      SELECT comparison_project_id AS comparisonProjectId, COUNT(*) AS routeCount
      FROM ${comparisonProjectImportRouteTable}
      GROUP BY comparison_project_id
    ) route_counts ON route_counts.comparisonProjectId = cp.id
    WHERE cp.archived = ${getBooleanLiteral(archived)}
    ORDER BY ${archived ? 'cp.created_at DESC' : 'cp.name ASC'}
  `)

  return rows.map((row) => {
    return {...row, humanJudgmentMode: row.humanJudgmentMode ?? 'prompt', createdAt: getDateValue(row.createdAt)}
  })
}
