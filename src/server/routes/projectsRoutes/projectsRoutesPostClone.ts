import {assertSelectableProviderModelId} from '../../providers/providerModelRepository.ts'
import {getAppDatabaseService} from '../../services/appDatabaseService.ts'
import {escapeSqlString, getDateValue, getSqlLiteral, getTimestampLiteral} from '../../services/appQueryHelpers.ts'
import {rejectLegacyFullTextNoImagesBody} from '../../utils/rejectLegacyFullTextNoImagesBody.ts'
import {getProjectValue} from './getProjectValue.ts'
import {assertProjectIsActive} from './projectAccessGuard.ts'
import {
  getProjectFullTextColumnValuesSql,
  getProjectFullTextSelectSql,
  getProjectFullTextValues,
  type ProjectFullTextRow,
} from './projectFullTextSettings.ts'
import {copyCloneSourceRowsTx} from './projectsRoutesPostClone/copyCloneSourceRowsTx.ts'

export const projectsRoutesPostClone = async ({body, params}: {body: unknown; params: {id: string}}) => {
  rejectLegacyFullTextNoImagesBody({body})

  await assertProjectIsActive(params.id)

  const [sourceProject] = await getAppDatabaseService()
    .queryJson<
      {
        id: string
        name: string
        description: string | null
        modelId: string
        humanJudgmentMode: 'prompt' | 'summary' | null
        systemPromptVariant: string | null
        useTitle: boolean
        useAbstract: boolean
        useFulltext: boolean
        useFulltextNoImages: boolean
        useMetadata: boolean
        dateFrom: unknown
        dateTo: unknown
      } & ProjectFullTextRow
    >(
      `
      SELECT
        id,
        name,
        description,
        model_id AS modelId,
        human_judgment_mode AS humanJudgmentMode,
        system_prompt_variant AS systemPromptVariant,
        use_title AS useTitle,
        use_abstract AS useAbstract,
        use_fulltext AS useFulltext,
        use_fulltext_no_images AS useFulltextNoImages,
        COALESCE(use_metadata, FALSE) AS useMetadata,
        ${getProjectFullTextSelectSql('app.project')},
        date_from AS dateFrom,
        date_to AS dateTo
      FROM app.project
      WHERE id = '${escapeSqlString(params.id)}'
        AND delete_pending_at IS NULL
        AND NOT EXISTS (
          SELECT 1
          FROM app.archived_project_delete_tombstone tombstone
          WHERE tombstone.project_id = app.project.id
            AND tombstone.completed_at IS NULL
        )
      LIMIT 1
    `,
    )
    .then((rows) => {
      return rows.map((row) => {
        return {
          ...getProjectFullTextValues(row),
          dateFrom: getDateValue(row.dateFrom),
          dateTo: getDateValue(row.dateTo),
        }
      })
    })

  if (!sourceProject) {
    throw new Error('Project not found')
  }

  await assertSelectableProviderModelId(getAppDatabaseService(), {
    errorMessage: 'Source project model does not exist or is disabled',
    modelId: sourceProject.modelId,
  })

  const clonedFullTextColumnValues = getProjectFullTextColumnValuesSql(sourceProject)
  const result = await getAppDatabaseService().transaction(async (tx) => {
    const clonedProjectId = crypto.randomUUID()
    const [clonedProject] = await tx.queryJson<
      {
        id: string
        name: string
        description: string | null
        modelId: string
        humanJudgmentMode: 'prompt' | 'summary' | null
        systemPromptVariant: string | null
        useTitle: boolean
        useAbstract: boolean
        useFulltext: boolean
        useFulltextNoImages: boolean
        useMetadata: boolean
        dateFrom: unknown
        dateTo: unknown
        archived: boolean
        createdAt: unknown
        updatedAt: unknown
      } & ProjectFullTextRow
    >(`
        INSERT INTO app.project (
          id,
          name,
          description,
          model_id,
          human_judgment_mode,
          system_prompt_variant,
          use_title,
          use_abstract,
          use_fulltext,
          use_fulltext_no_images,
          use_metadata,
          full_text_figure_mode,
          full_text_chunk_policy,
          full_text_strategy_id,
          date_from,
          date_to,
          archived
        )
        VALUES (
          '${escapeSqlString(clonedProjectId)}',
          ${getSqlLiteral(`${sourceProject.name} - Copy`)},
          ${getSqlLiteral(sourceProject.description)},
          '${escapeSqlString(sourceProject.modelId)}',
          ${getSqlLiteral(sourceProject.humanJudgmentMode ?? 'prompt')},
          ${getSqlLiteral(sourceProject.systemPromptVariant)},
          ${sourceProject.useTitle ? 'TRUE' : 'FALSE'},
          ${sourceProject.useAbstract ? 'TRUE' : 'FALSE'},
          ${sourceProject.useFulltext ? 'TRUE' : 'FALSE'},
          ${sourceProject.useFulltextNoImages ? 'TRUE' : 'FALSE'},
          ${sourceProject.useMetadata ? 'TRUE' : 'FALSE'},
          ${clonedFullTextColumnValues.fullTextFigureMode},
          ${clonedFullTextColumnValues.fullTextChunkPolicy},
          ${clonedFullTextColumnValues.fullTextStrategyId},
          ${sourceProject.dateFrom ? getTimestampLiteral(sourceProject.dateFrom) : 'NULL'},
          ${sourceProject.dateTo ? getTimestampLiteral(sourceProject.dateTo) : 'NULL'},
          FALSE
        )
        RETURNING
          id,
          name,
          description,
          model_id AS modelId,
          human_judgment_mode AS humanJudgmentMode,
          system_prompt_variant AS systemPromptVariant,
          use_title AS useTitle,
          use_abstract AS useAbstract,
          use_fulltext AS useFulltext,
          use_fulltext_no_images AS useFulltextNoImages,
          COALESCE(use_metadata, FALSE) AS useMetadata,
          full_text_figure_mode AS fullTextFigureMode,
          TO_JSON(full_text_chunk_policy) AS fullTextChunkPolicy,
          full_text_strategy_id AS fullTextStrategyId,
          ${getSqlLiteral(sourceProject.fullTextStrategyLabel)} AS fullTextStrategyStoredLabel,
          date_from AS dateFrom,
          date_to AS dateTo,
          archived,
          created_at AS createdAt,
          updated_at AS updatedAt
      `)

    if (!clonedProject) {
      throw new Error('Failed to create cloned project')
    }

    await copyCloneSourceRowsTx(tx, {clonedProject, params, sourceProject})

    return getProjectValue(clonedProject)
  })

  return {data: result}
}
