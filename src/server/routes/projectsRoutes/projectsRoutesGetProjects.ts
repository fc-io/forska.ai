import {getSystemPromptVariant} from '../../../agent/judge/systemPromptVariant.ts'
import {getAppDatabaseService} from '../../services/appDatabaseService.ts'
import {getDateValue} from '../../services/appQueryHelpers.ts'
import {getProjectModelLabel} from './getProjectModelLabel.ts'
import {
  getProjectFullTextSelectSql,
  getProjectFullTextValues,
  type ProjectFullTextRow,
} from './projectFullTextSettings.ts'

export const projectsRoutesGetProjects = async () => {
  const projectsWithModelName = await getAppDatabaseService()
    .queryJson<
      {
        id: string
        name: string
        description: string | null
        modelId: string
        useTitle: boolean
        useAbstract: boolean
        useFulltext: boolean
        useFulltextNoImages: boolean
        useMetadata: boolean
        humanJudgmentMode: 'prompt' | 'summary' | null
        systemPromptVariant: string | null
        dateFrom: unknown
        dateTo: unknown
        archived: boolean
        createdAt: unknown
        updatedAt: unknown
        modelMetadataJson: unknown
        modelName: string | null
        modelProvider: string | null
        modelVersion: string | null
      } & ProjectFullTextRow
    >(
      `
      SELECT
        p.id AS id,
        p.name AS name,
        p.description AS description,
        p.model_id AS modelId,
        p.use_title AS useTitle,
        p.use_abstract AS useAbstract,
        p.use_fulltext AS useFulltext,
        p.use_fulltext_no_images AS useFulltextNoImages,
        COALESCE(p.use_metadata, FALSE) AS useMetadata,
        p.human_judgment_mode AS humanJudgmentMode,
        p.system_prompt_variant AS systemPromptVariant,
        ${getProjectFullTextSelectSql('p')},
        p.date_from AS dateFrom,
        p.date_to AS dateTo,
        p.archived AS archived,
        p.created_at AS createdAt,
        p.updated_at AS updatedAt,
        TO_JSON(m.metadata_json) AS modelMetadataJson,
        COALESCE(m.display_name, m.name, m.remote_model_id) AS modelName,
        pc.provider_kind AS modelProvider,
        m.variant AS modelVersion
      FROM app.project p
      LEFT JOIN app.model m ON p.model_id = m.id
      LEFT JOIN app.provider_connection pc ON pc.id = m.provider_connection_id
      WHERE p.archived = FALSE
        AND p.delete_pending_at IS NULL
        AND NOT EXISTS (
          SELECT 1
          FROM app.archived_project_delete_tombstone tombstone
          WHERE tombstone.project_id = p.id
            AND tombstone.completed_at IS NULL
        )
      ORDER BY p.name ASC
    `,
    )
    .then((rows) => {
      return rows.map((row) => {
        const {modelMetadataJson: _modelMetadataJson, ...projectRow} = row

        return {
          ...getProjectFullTextValues(projectRow),
          systemPromptVariant: getSystemPromptVariant(projectRow.systemPromptVariant),
          dateFrom: getDateValue(projectRow.dateFrom),
          dateTo: getDateValue(projectRow.dateTo),
          createdAt: getDateValue(projectRow.createdAt),
          modelName: getProjectModelLabel({
            metadataJson: row.modelMetadataJson,
            modelName: projectRow.modelName,
            provider: row.modelProvider,
            version: row.modelVersion,
          }),
          updatedAt: getDateValue(projectRow.updatedAt),
        }
      })
    })

  return {data: projectsWithModelName}
}
