import {getSystemPromptVariant} from '../../../agent/judge/systemPromptVariant.ts'
import {getEffectiveFullTextStrategyId} from '../../fullText/fullTextStrategy.ts'
import {assertSelectableProviderModelId} from '../../providers/providerModelRepository.ts'
import {getAppDatabaseService} from '../../services/appDatabaseService.ts'
import * as appQueryHelpers from '../../services/appQueryHelpers.ts'
import {assertSubprojectDateRange} from './subprojectsRoutesPostCreate/assertSubprojectDateRange.ts'
import {collectSubprojectArticleIds} from './subprojectsRoutesPostCreate/collectSubprojectArticleIds.ts'
import {insertSubproject} from './subprojectsRoutesPostCreate/insertSubproject.ts'
import type {ProjectBound, PromptRow} from './subprojectsRoutesPostCreate/subprojectTypes.ts'
import type {subprojectsRoutesPostCreateBody} from './subprojectsRoutesPostCreateBody.ts'

export const subprojectsRoutesPostCreate = async ({body}: {body: typeof subprojectsRoutesPostCreateBody.static}) => {
  const appDatabaseService = getAppDatabaseService()
  assertSubprojectDateRange(body)

  await assertSelectableProviderModelId(appDatabaseService, {
    errorMessage: 'Selected model does not exist or is disabled',
    modelId: body.modelId,
  })

  const promptIdSet = body.promptSelections.reduce((set, selection) => {
    set.add(selection.promptId)
    return set
  }, new Set<string>())
  const promptIds = Array.from(promptIdSet)
  const promptDetails =
    promptIds.length === 0
      ? []
      : await appDatabaseService.queryJson<PromptRow>(`
              SELECT
                id,
                prompt_heading AS promptHeading,
                original_text AS originalText,
                transformed_text AS transformedText,
                type,
                archived
              FROM app.prompt
              WHERE id IN (${appQueryHelpers.getQuotedStringList(promptIds).join(', ')})
            `)

  const promptDetailsById = promptDetails.reduce<Map<string, PromptRow>>((map, prompt) => {
    map.set(prompt.id, prompt)
    return map
  }, new Map<string, PromptRow>())
  const orderedPromptDetails = promptIds.reduce<PromptRow[]>((result, promptId) => {
    const prompt = promptDetailsById.get(promptId)

    return prompt ? [...result, prompt] : result
  }, [])

  const promptFilters =
    body.sourceProjectIds.length === 0
      ? []
      : body.promptSelections.filter((selection) => {
          return selection.types.length > 0
        })
  const allSelectedPromptIds = promptFilters.map((filter) => {
    return filter.promptId
  })
  const [projectImportRoutes, projectBoundsRows] =
    body.sourceProjectIds.length === 0
      ? [[], []]
      : await Promise.all([
          appDatabaseService.queryJson<{projectId: string; importRouteId: string}>(`
                SELECT
                  project_id AS projectId,
                  import_route_id AS importRouteId
                FROM app.project_import_route
                WHERE project_id IN (${appQueryHelpers.getQuotedStringList(body.sourceProjectIds).join(', ')})
              `),
          appDatabaseService.queryJson<{
            id: string
            dateFrom: unknown
            dateTo: unknown
            modelId: string | null
            useTitle: boolean | null
            useAbstract: boolean | null
            useFulltext: boolean | null
            useFulltextNoImages: boolean | null
            useMetadata: boolean | null
            systemPromptVariant: string | null
            fullTextStrategyId: string | null
          }>(`
                SELECT
                  id,
                  date_from AS dateFrom,
                  date_to AS dateTo,
                  model_id AS modelId,
                  use_title AS useTitle,
                  use_abstract AS useAbstract,
                  use_fulltext AS useFulltext,
                  use_fulltext_no_images AS useFulltextNoImages,
                  COALESCE(use_metadata, FALSE) AS useMetadata,
                  system_prompt_variant AS systemPromptVariant,
                  full_text_strategy_id AS fullTextStrategyId
                FROM app.project
                WHERE id IN (${appQueryHelpers.getQuotedStringList(body.sourceProjectIds).join(', ')})
              `),
        ])
  const projectBounds = projectBoundsRows.map<ProjectBound>((row) => {
    return {
      id: row.id,
      dateFrom: appQueryHelpers.getDateValue(row.dateFrom),
      dateTo: appQueryHelpers.getDateValue(row.dateTo),
      modelId: row.modelId,
      useTitle: row.useTitle ?? true,
      useAbstract: row.useAbstract ?? true,
      useFulltext: row.useFulltext ?? false,
      useFulltextNoImages: row.useFulltextNoImages ?? false,
      useMetadata: row.useMetadata ?? false,
      systemPromptVariant: getSystemPromptVariant(row.systemPromptVariant),
      fullTextStrategyId: getEffectiveFullTextStrategyId(row.fullTextStrategyId),
    }
  })
  const importRouteIdsByProjectId = projectImportRoutes.reduce<Map<string, string[]>>((map, row) => {
    const currentIds = map.get(row.projectId) ?? []
    currentIds.push(row.importRouteId)
    map.set(row.projectId, currentIds)
    return map
  }, new Map<string, string[]>())
  const articleIds = await collectSubprojectArticleIds({
    allSelectedPromptIds,
    body,
    importRouteIdsByProjectId,
    projectBounds,
    promptFilters,
  })

  const newProject = await insertSubproject({articleIds, body, orderedPromptDetails, projectBounds})

  console.log(`[subprojects] Inserted ${articleIds.length} articles into project ${newProject.id}`)

  return {
    data: {
      project: {
        ...newProject,
        dateFrom: appQueryHelpers.getDateValue(newProject.dateFrom),
        dateTo: appQueryHelpers.getDateValue(newProject.dateTo),
      },
      articleCount: articleIds.length,
    },
  }
}
