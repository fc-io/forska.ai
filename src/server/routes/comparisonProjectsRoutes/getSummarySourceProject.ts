import type {HumanJudgmentMode} from '../../../db/schemaTypes.ts'
import {getSqlLiteral} from '../../services/appQueryHelpers.ts'
import {modelTable, projectTable} from './comparisonProjectRouteConstants.ts'
import {appDatabaseService} from './comparisonProjectRouteServices.ts'
import type {AppQueryRunner} from './comparisonProjectRouteTypes.ts'
import type {ComparisonProjectSummarySourceProject} from './comparisonProjectScopeTypes.ts'

export const getSummarySourceProject = async (
  summarySourceProjectId: string | null,
  queryRunner: AppQueryRunner = appDatabaseService,
) => {
  if (!summarySourceProjectId) {
    return null
  }

  const [sourceProjectRow] = await queryRunner.queryJson<
    Omit<ComparisonProjectSummarySourceProject, 'humanJudgmentMode' | 'useMetadata'> & {
      humanJudgmentMode: HumanJudgmentMode | null
      useMetadata?: boolean | null
    }
  >(`
    SELECT
      p.id AS id,
      p.name AS name,
      p.description AS description,
      p.model_id AS modelId,
      COALESCE(m.display_name, m.name, m.remote_model_id, p.model_id) AS modelName,
      p.human_judgment_mode AS humanJudgmentMode,
      p.use_title AS useTitle,
      p.use_abstract AS useAbstract,
      p.use_fulltext AS useFulltext,
      p.use_fulltext_no_images AS useFulltextNoImages,
      COALESCE(p.use_metadata, FALSE) AS useMetadata
    FROM ${projectTable} p
    LEFT JOIN ${modelTable} m ON m.id = p.model_id
    WHERE p.id = ${getSqlLiteral(summarySourceProjectId)}
    LIMIT 1
  `)

  return sourceProjectRow
    ? {
        ...sourceProjectRow,
        humanJudgmentMode: sourceProjectRow.humanJudgmentMode ?? 'prompt',
        useMetadata: sourceProjectRow.useMetadata === true,
      }
    : null
}
