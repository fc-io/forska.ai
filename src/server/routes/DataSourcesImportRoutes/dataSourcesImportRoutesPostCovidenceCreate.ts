import {randomUUID} from 'node:crypto'

import {requestReviewServingV4Rebuild} from '../../reviewServing/reviewServingV4RebuildRequestService.ts'
import {getAppDatabaseService} from '../../services/appDatabaseService.ts'
import {escapeSqlString, getSqlLiteral, getTimestampLiteral} from '../../services/appQueryHelpers.ts'
import {
  buildCovidencePackageConfig,
  buildCovidencePromptDefinition,
  buildCovidencePromptDefinitionsForEligibilityFields,
  deleteCovidencePackageFiles,
  getCovidencePackageCursor,
  getOrCreateCovidenceProject,
  getOrCreateCovidencePrompt,
  importCovidencePackageFromConfig,
  seedCovidenceHumanJudgmentsFromConfig,
  storeCovidencePackageFiles,
  syncCovidenceProjectPrompts,
  syncCovidenceProjectScopeFromConfig,
} from '../../services/covidenceImportService.ts'
import {getDataSourceQueryService} from '../../services/dataSourceQueryService.ts'

type CovidenceImportMode = 'title_abstract' | 'full_text'
type CovidenceFileRole = 'all' | 'irrelevant' | 'full_text' | 'excluded' | 'included'
type CovidencePromptAnswerSet = 'yes|no' | 'yes|no|maybe' | 'yes_no' | 'yes_no_maybe'
type CovidencePromptGrouping = 'per_field' | 'per_section' | 'single_prompt'
type CreatedCovidenceProject = {id: string} & Record<string, unknown>
type CovidencePackageUploadInput = Blob & {name?: string; type?: string}
type CovidenceEligibilityFieldDisposition = 'include' | 'exclude'
type CovidenceEligibilityField = {
  disposition: CovidenceEligibilityFieldDisposition
  sectionKey: string
  sectionLabel: string
  text: string
}

const getNormalizedCovidenceEligibilityFields = (eligibilityFields?: CovidenceEligibilityField[]) => {
  return (eligibilityFields ?? [])
    .map((eligibilityField) => {
      return {
        disposition: eligibilityField.disposition,
        sectionKey: eligibilityField.sectionKey.trim(),
        sectionLabel: eligibilityField.sectionLabel.trim(),
        text: eligibilityField.text.trim(),
      }
    })
    .filter((eligibilityField) => {
      return eligibilityField.text !== ''
    })
}

const getCovidencePromptDefinitions = (body: {
  answerSet?: CovidencePromptAnswerSet
  eligibilityFields?: CovidenceEligibilityField[]
  exclusionCriteria?: string
  inclusionCriteria?: string
  mode: CovidenceImportMode
  promptGrouping?: CovidencePromptGrouping
}) => {
  if (typeof body.answerSet !== 'string') {
    return null
  }

  if (Array.isArray(body.eligibilityFields)) {
    const eligibilityFields = getNormalizedCovidenceEligibilityFields(body.eligibilityFields)

    return eligibilityFields.length === 0
      ? null
      : buildCovidencePromptDefinitionsForEligibilityFields({
          answerSet: body.answerSet,
          eligibilityFields,
          mode: body.mode,
          promptGrouping: body.promptGrouping,
        })
  }

  const inclusionCriteria = body.inclusionCriteria?.trim() ?? ''
  const exclusionCriteria = body.exclusionCriteria?.trim() ?? ''

  return inclusionCriteria || exclusionCriteria
    ? [
        buildCovidencePromptDefinition({
          answerSet: body.answerSet,
          exclusionCriteria,
          inclusionCriteria,
          mode: body.mode,
        }),
      ]
    : null
}

const getCreatedCovidenceProject = (result: unknown): CreatedCovidenceProject | null => {
  const value =
    result !== null && typeof result === 'object' && 'covidenceProject' in result ? result.covidenceProject : null

  return value !== null && typeof value === 'object' && 'id' in value && typeof value.id === 'string'
    ? (value as CreatedCovidenceProject)
    : null
}

const getCanRequestReviewServingBootstrap = () => {
  return typeof (getAppDatabaseService() as {queryJson?: unknown}).queryJson === 'function'
}

export const dataSourcesImportRoutesPostCovidenceCreate = async (body: {
  title: string
  description?: string
  modelId?: string
  answerSet?: CovidencePromptAnswerSet
  promptGrouping?: CovidencePromptGrouping
  eligibilityFields?: CovidenceEligibilityField[]
  exclusionCriteria?: string
  inclusionCriteria?: string
  mode: CovidenceImportMode
  files: Array<{file: CovidencePackageUploadInput; fileRole: CovidenceFileRole}>
}) => {
  const dataSourceId = randomUUID()
  const title = body.title.trim()

  if (!title) {
    throw new Error('Title is required')
  }

  const storedFiles = await storeCovidencePackageFiles({datasourceId: dataSourceId, files: body.files})
  const config = buildCovidencePackageConfig({files: storedFiles, mode: body.mode})
  const cursor = getCovidencePackageCursor(config)
  const importRoute = `covidence:${dataSourceId}`
  const covidencePromptDefinitions = getCovidencePromptDefinitions(body)
  const result = (await getAppDatabaseService()
    .transaction(async (tx) => {
      const covidencePrompts = covidencePromptDefinitions
        ? await Promise.all(
            covidencePromptDefinitions.map(async (promptDefinition) => {
              const covidencePrompt = await getOrCreateCovidencePrompt({promptDefinition, tx})

              return {
                ...covidencePrompt,
                criteriaDisposition: covidencePrompt.criteriaDisposition ?? promptDefinition.criteriaDisposition,
                criteriaSectionKey: covidencePrompt.criteriaSectionKey ?? promptDefinition.criteriaSectionKey,
                criteriaSectionLabel: covidencePrompt.criteriaSectionLabel ?? promptDefinition.criteriaSectionLabel,
              }
            }),
          )
        : []

      await tx.run(`
        INSERT INTO app.data_source (id, title, description, import_route, cursor)
        VALUES (
          '${escapeSqlString(dataSourceId)}',
          ${getSqlLiteral(title)},
          ${getSqlLiteral(body.description?.trim() ? body.description : null)},
          ${getSqlLiteral(importRoute)},
          ${getSqlLiteral(cursor)}
        )
      `)

      const importResult = await importCovidencePackageFromConfig({config, datasourceId: dataSourceId, importRoute, tx})
      const updatedAt = new Date()

      await tx.run(`
        UPDATE app.import_route
        SET name = ${getSqlLiteral(title)}
        WHERE route = ${getSqlLiteral(importRoute)}
      `)

      await tx.run(`
        UPDATE app.data_source
        SET last_import_at = ${getTimestampLiteral(updatedAt)},
            items_after_last_import = ${importResult.stats.importedCount},
            updated_at = ${getTimestampLiteral(updatedAt)},
            import_route = ${getSqlLiteral(importRoute)},
            cursor = ${getSqlLiteral(cursor)}
        WHERE id = '${escapeSqlString(dataSourceId)}'
      `)

      const covidenceProject = await getOrCreateCovidenceProject({
        importRoute,
        modelId: body.modelId,
        mode: body.mode,
        promptId: null,
        title,
        tx,
      })

      await syncCovidenceProjectPrompts({
        projectId: covidenceProject.id,
        promptLinks: covidencePrompts.map((covidencePrompt) => {
          return {
            criteriaDisposition: covidencePrompt.criteriaDisposition,
            criteriaSectionKey: covidencePrompt.criteriaSectionKey,
            criteriaSectionLabel: covidencePrompt.criteriaSectionLabel,
            promptId: covidencePrompt.id,
          }
        }),
        tx,
      })

      await syncCovidenceProjectScopeFromConfig({
        config,
        importRoute,
        packageRows: importResult.packageRows,
        projectId: covidenceProject.id,
        tx,
      })
      await seedCovidenceHumanJudgmentsFromConfig({
        config,
        importRoute,
        packageRows: importResult.packageRows,
        projectId: covidenceProject?.id ?? null,
        tx,
      })

      const {packageRows: _packageRows, ...responseImportResult} = importResult

      return {...responseImportResult, covidenceProject, covidencePrompts}
    })
    .catch(async (error) => {
      deleteCovidencePackageFiles(dataSourceId)
      throw error
    })) as Awaited<ReturnType<typeof importCovidencePackageFromConfig>>

  const dataSource = await getDataSourceQueryService().getDataSourceById(dataSourceId)
  const covidenceProject = getCreatedCovidenceProject(result)

  if (!dataSource) {
    throw new Error('Data source not found after Covidence import create')
  }

  if (covidenceProject !== null && getCanRequestReviewServingBootstrap()) {
    requestReviewServingV4Rebuild({projectId: covidenceProject.id, reason: 'missingReviewServingSnapshot'}).catch(
      () => {
        return undefined
      },
    )
  }

  return {
    success: true,
    data: {
      covidencePackageConfig: config,
      covidenceProject,
      covidencePrompts: 'covidencePrompts' in result ? result.covidencePrompts : [],
      dataSource,
      stats: result.stats,
    },
  }
}
