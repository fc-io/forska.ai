import {getJsonValue, getSqlLiteral} from '../services/appQueryHelpers.ts'
import {
  buildPromptConfigHash,
  buildReviewConfigHash,
  type ReviewServingIdentityValue,
} from './reviewProjectionIdentity.ts'

export type ReviewServingReviewConfigDatabase = {queryJson: <T>(statement: string) => Promise<T[]>}

export type ReviewServingProjectPromptConfigRow = {
  answerSchemaHash: string | null
  promptId: string
  promptOrder: number | null
  promptTextHash: string | null
  settingsVersion: string | null
  thresholdVersion: string | null
}

export type ReviewServingProjectReviewSettingsRow = {
  humanJudgmentMode: 'prompt' | 'summary'
  modelExecutionOptions: string | null
  modelId: string | null
  modelProviderBaseUrl: string | null
  modelProviderConnectionId: string | null
  modelProviderKind: string | null
  modelRemoteModelId: string | null
  modelVariant: string | null
  useAbstract: boolean
  useFulltext: boolean
  useFulltextNoImages: boolean
  useTitle: boolean
}

export const getReviewServingProjectPromptConfigRows = async (
  projectId: string,
  database: ReviewServingReviewConfigDatabase,
) => {
  return database.queryJson<ReviewServingProjectPromptConfigRow>(`
    SELECT
      prompt.id AS promptId,
      project_prompt.prompt_order AS promptOrder,
      COALESCE(prompt.content_hash, sha256(prompt.original_text)) AS promptTextHash,
      NULL AS answerSchemaHash,
      'prompt-v1' AS settingsVersion,
      NULL AS thresholdVersion
    FROM app.project_prompt project_prompt
    INNER JOIN app.prompt prompt
      ON prompt.id = project_prompt.prompt_id
    WHERE project_prompt.project_id = ${getSqlLiteral(projectId)}
      AND project_prompt.enabled
      AND NOT project_prompt.archived
      AND COALESCE(prompt.archived, FALSE) = FALSE
    ORDER BY COALESCE(project_prompt.prompt_order, 0) ASC, prompt.id ASC
  `)
}

export const getReviewServingProjectReviewSettings = async (
  projectId: string,
  database: ReviewServingReviewConfigDatabase,
) => {
  const rows = await database.queryJson<ReviewServingProjectReviewSettingsRow>(`
    SELECT
      COALESCE(project.human_judgment_mode, 'prompt') AS humanJudgmentMode,
      project.model_id AS modelId,
      model.provider_connection_id AS modelProviderConnectionId,
      provider_connection.provider_kind AS modelProviderKind,
      provider_connection.base_url AS modelProviderBaseUrl,
      model.remote_model_id AS modelRemoteModelId,
      model.variant AS modelVariant,
      TO_JSON(json_extract(model.metadata_json, '$.options')) AS modelExecutionOptions,
      project.use_title AS useTitle,
      project.use_abstract AS useAbstract,
      project.use_fulltext AS useFulltext,
      project.use_fulltext_no_images AS useFulltextNoImages
    FROM app.project project
    LEFT JOIN app.model model
      ON model.id = project.model_id
    LEFT JOIN app.provider_connection provider_connection
      ON provider_connection.id = model.provider_connection_id
    WHERE project.id = ${getSqlLiteral(projectId)}
    LIMIT 1
  `)

  return rows[0] ?? null
}

export const getReviewServingPromptConfigHash = (
  row: Pick<
    ReviewServingProjectPromptConfigRow,
    'answerSchemaHash' | 'promptId' | 'promptTextHash' | 'settingsVersion' | 'thresholdVersion'
  >,
) => {
  return buildPromptConfigHash({
    answerSchemaHash: row.answerSchemaHash,
    promptId: row.promptId,
    promptTextHash: row.promptTextHash ?? row.promptId,
    settingsVersion: row.settingsVersion ?? 'prompt-v1',
    thresholdVersion: row.thresholdVersion,
  })
}

export const getReviewServingReviewConfigHash = (
  input: ReviewServingProjectReviewSettingsRow & {promptConfigRows: readonly ReviewServingProjectPromptConfigRow[]},
) => {
  return buildReviewConfigHash({
    humanJudgmentMode: input.humanJudgmentMode,
    modelExecutionIdentity: {
      modelExecutionOptions: getJsonValue(input.modelExecutionOptions) as ReviewServingIdentityValue,
      modelId: input.modelId,
      providerBaseUrl: input.modelProviderBaseUrl,
      providerConnectionId: input.modelProviderConnectionId,
      providerKind: input.modelProviderKind,
      remoteModelId: input.modelRemoteModelId,
      variant: input.modelVariant,
    },
    modelId: input.modelId,
    promptConfigs: input.promptConfigRows.map((row, index) => {
      return {
        promptConfigHash: getReviewServingPromptConfigHash(row),
        promptId: row.promptId,
        promptOrder: row.promptOrder ?? index,
      }
    }),
    useAbstract: input.useAbstract,
    useFulltext: input.useFulltext,
    useFulltextNoImages: input.useFulltextNoImages,
    useTitle: input.useTitle,
  })
}

export const getCurrentReviewServingReviewConfigHash = async (
  projectId: string,
  database: ReviewServingReviewConfigDatabase,
) => {
  const projectSettings = await getReviewServingProjectReviewSettings(projectId, database)

  if (projectSettings === null) {
    return null
  }

  const promptConfigRows = await getReviewServingProjectPromptConfigRows(projectId, database)

  return getReviewServingReviewConfigHash({...projectSettings, promptConfigRows})
}
