import {getAppDatabaseService} from '../../../services/appDatabaseService.ts'
import {getSqlLiteral} from '../../../services/appQueryHelpers.ts'
import {getPromptPreviewWorkloadContext} from './getPromptPreviewWorkloadContext.ts'

export type PromptPreviewArticleDetailsRow = {
  fullText: string | null
  fullTextAssets: unknown
  fullTextCanonicalVersion: string | null
  fullTextFigureModeBuilt: string | null
  publicationStatus: string | null
}

export const getPromptPreviewArticleDetails = async (params: {
  articleId: string
  includeFullText: boolean
  projectId: string
}) => {
  const rows = await getAppDatabaseService().queryJson<PromptPreviewArticleDetailsRow>(
    `
    SELECT
      ${params.includeFullText ? 'full_text' : 'CAST(NULL AS VARCHAR)'} AS fullText,
      ${params.includeFullText ? 'TO_JSON(full_text_assets)' : 'NULL'} AS fullTextAssets,
      ${params.includeFullText ? 'full_text_canonical_version' : 'CAST(NULL AS VARCHAR)'} AS fullTextCanonicalVersion,
      ${params.includeFullText ? 'full_text_figure_mode_built' : 'CAST(NULL AS VARCHAR)'} AS fullTextFigureModeBuilt,
      publication_status AS publicationStatus
    FROM app.article
    WHERE id = ${getSqlLiteral(params.articleId)}
    LIMIT 1
  `,
    getPromptPreviewWorkloadContext({maxResultRows: 1, operation: 'articleDetails', projectId: params.projectId}),
  )

  return rows[0] ?? null
}
