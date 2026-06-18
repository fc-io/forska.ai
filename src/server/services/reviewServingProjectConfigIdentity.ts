import {
  buildPromptConfigHash,
  buildReviewConfigHash,
  type ReviewServingIdentityValue,
} from '../reviewServing/reviewProjectionIdentity.ts'
import {getAppDatabaseService} from './appDatabaseService.ts'
import {getJsonValue, getSqlLiteral} from './appQueryHelpers.ts'

export const getCurrentReviewConfigHash = async (projectId: string) => {
  const [project] = await getAppDatabaseService().queryJson<{
    humanJudgmentMode: 'prompt' | 'summary' | null
    modelExecutionOptions: unknown
    modelId: string
    modelProviderBaseUrl: string | null
    modelProviderConnectionId: string | null
    modelProviderKind: string | null
    modelRemoteModelId: string | null
    modelVariant: string | null
    useAbstract: boolean
    useFulltext: boolean
    useFulltextNoImages: boolean
    useTitle: boolean
  }>(`
    SELECT
      app.project.human_judgment_mode AS humanJudgmentMode,
      app.project.model_id AS modelId,
      model.provider_connection_id AS modelProviderConnectionId,
      provider_connection.provider_kind AS modelProviderKind,
      provider_connection.base_url AS modelProviderBaseUrl,
      model.remote_model_id AS modelRemoteModelId,
      model.variant AS modelVariant,
      TO_JSON(json_extract(model.metadata_json, '$.options')) AS modelExecutionOptions,
      app.project.use_title AS useTitle,
      app.project.use_abstract AS useAbstract,
      app.project.use_fulltext AS useFulltext,
      app.project.use_fulltext_no_images AS useFulltextNoImages
    FROM app.project
    LEFT JOIN app.model model
      ON model.id = app.project.model_id
    LEFT JOIN app.provider_connection provider_connection
      ON provider_connection.id = model.provider_connection_id
    WHERE app.project.id = ${getSqlLiteral(projectId)}
    LIMIT 1
  `)
  const promptConfigs = await getAppDatabaseService().queryJson<{
    promptId: string
    promptOrder: number | null
    promptTextHash: string | null
  }>(`
    SELECT
      prompt.id AS promptId,
      project_prompt.prompt_order AS promptOrder,
      COALESCE(prompt.content_hash, sha256(prompt.original_text)) AS promptTextHash
    FROM app.project_prompt project_prompt
    INNER JOIN app.prompt prompt
      ON prompt.id = project_prompt.prompt_id
    WHERE project_prompt.project_id = ${getSqlLiteral(projectId)}
      AND project_prompt.enabled
      AND NOT project_prompt.archived
      AND COALESCE(prompt.archived, FALSE) = FALSE
    ORDER BY COALESCE(project_prompt.prompt_order, 0) ASC, prompt.id ASC
  `)

  return project === undefined
    ? null
    : buildReviewConfigHash({
        humanJudgmentMode: project.humanJudgmentMode ?? 'prompt',
        modelExecutionIdentity: {
          modelExecutionOptions: getJsonValue(project.modelExecutionOptions) as ReviewServingIdentityValue,
          modelId: project.modelId,
          providerBaseUrl: project.modelProviderBaseUrl,
          providerConnectionId: project.modelProviderConnectionId,
          providerKind: project.modelProviderKind,
          remoteModelId: project.modelRemoteModelId,
          variant: project.modelVariant,
        },
        modelId: project.modelId,
        promptConfigs: promptConfigs.map((row, index) => {
          return {
            promptConfigHash: buildPromptConfigHash({
              answerSchemaHash: null,
              promptId: row.promptId,
              promptTextHash: row.promptTextHash ?? row.promptId,
              settingsVersion: 'prompt-v1',
              thresholdVersion: null,
            }),
            promptId: row.promptId,
            promptOrder: row.promptOrder ?? index,
          }
        }),
        useAbstract: project.useAbstract,
        useFulltext: project.useFulltext,
        useFulltextNoImages: project.useFulltextNoImages,
        useTitle: project.useTitle,
      })
}
