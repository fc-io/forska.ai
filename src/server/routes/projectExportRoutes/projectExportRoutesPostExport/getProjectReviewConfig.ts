import {getProjectFullTextStrategyIdSql} from '../../../fullText/fullTextStrategy.ts'
import {getAppDatabaseService} from '../../../services/appDatabaseService.ts'
import {getSqlLiteral} from '../../../services/appQueryHelpers.ts'
import {getProjectExportWorkloadContext} from '../getProjectExportWorkloadContext.ts'

type ExportReviewConfig = {
  modelId: string | null
  useAbstract: boolean
  useFulltext: boolean
  useFulltextNoImages: boolean
  useMetadata: boolean
  useTitle: boolean
  fullTextStrategyId: string
}

export const getProjectReviewConfig = async (projectId: string) => {
  const [project] = await getAppDatabaseService().queryJson<ExportReviewConfig>(
    `
    SELECT
      model_id AS modelId,
      use_title AS useTitle,
      use_abstract AS useAbstract,
      use_fulltext AS useFulltext,
      use_fulltext_no_images AS useFulltextNoImages,
      COALESCE(use_metadata, FALSE) AS useMetadata,
      ${getProjectFullTextStrategyIdSql('app.project')} AS fullTextStrategyId
    FROM app.project
    WHERE id = ${getSqlLiteral(projectId)}
    LIMIT 1
  `,
    getProjectExportWorkloadContext({maxResultRows: 1, operation: 'projectReviewConfig', projectId}),
  )

  return project ?? null
}
