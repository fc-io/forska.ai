import {randomUUID} from 'node:crypto'

import {getAppDatabaseService} from '../../services/appDatabaseService.ts'
import {escapeSqlString, getQuotedStringList, getSqlLiteral} from '../../services/appQueryHelpers.ts'
import {articleImportStoreWorkloadContext} from '../../services/articleImportStoreService.ts'
import {
  buildCovidencePackageConfig,
  buildCovidencePromptDefinition,
  buildCovidencePromptDefinitionsForEligibilityFields,
  type CovidencePackageConfig,
  deleteCovidencePackageFiles,
  getCovidencePackageCursor,
  getCovidencePackageRowsFromConfig,
  getOrCreateCovidenceProject,
  getOrCreateCovidencePrompt,
  storeCovidencePackageFiles,
  syncCovidenceProjectPrompts,
} from '../../services/covidenceImportService.ts'
import {getDataSourceQueryService} from '../../services/dataSourceQueryService.ts'
import {
  getCovidenceImportRoute,
  startCovidencePackageImportInBackground,
} from './startCovidencePackageImportInBackground.ts'

type CovidenceImportMode = 'title_abstract' | 'full_text'
type CovidenceFileRole = 'all' | 'irrelevant' | 'full_text' | 'excluded' | 'included'
type CovidencePromptAnswerSet = 'yes|no' | 'yes|no|maybe' | 'yes_no' | 'yes_no_maybe'
type CovidencePromptGrouping = 'per_field' | 'per_section' | 'single_prompt'
type CovidencePackageUploadInput = Blob & {name?: string; type?: string}
type CovidenceEligibilityFieldDisposition = 'include' | 'exclude'
type CovidenceEligibilityField = {
  disposition: CovidenceEligibilityFieldDisposition
  sectionKey: string
  sectionLabel: string
  text: string
}
type CovidencePromptDefinitions = ReturnType<typeof buildCovidencePromptDefinitionsForEligibilityFields>

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

const createCovidenceProjectRecords = async (input: {
  config: CovidencePackageConfig
  cursor: string
  dataSourceId: string
  description: string | null
  importRoute: string
  modelId?: string
  promptDefinitions: CovidencePromptDefinitions | null
  title: string
}) => {
  const packageRows = getCovidencePackageRowsFromConfig(input.config)
  const project = await getAppDatabaseService().transaction(async (tx) => {
    const covidencePrompts = input.promptDefinitions
      ? await Promise.all(
          input.promptDefinitions.map(async (promptDefinition) => {
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
        '${escapeSqlString(input.dataSourceId)}',
        ${getSqlLiteral(input.title)},
        ${getSqlLiteral(input.description)},
        ${getSqlLiteral(input.importRoute)},
        ${getSqlLiteral(input.cursor)}
      )
    `)

    await tx.run(`
      INSERT INTO app.import_route (id, route, name, active)
      VALUES (${getQuotedStringList([randomUUID(), input.importRoute, input.title]).join(', ')}, TRUE)
      ON CONFLICT(route) DO NOTHING
    `)

    const covidenceProject = await getOrCreateCovidenceProject({
      importRoute: input.importRoute,
      modelId: input.modelId,
      mode: input.config.mode,
      promptId: null,
      title: input.title,
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

    return {covidenceProject, covidencePrompts}
  }, articleImportStoreWorkloadContext)

  return {...project, packageRows}
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
  const created = await createCovidenceProjectRecords({
    config,
    cursor: getCovidencePackageCursor(config),
    dataSourceId,
    description: body.description?.trim() ? body.description : null,
    importRoute: getCovidenceImportRoute(dataSourceId),
    modelId: body.modelId,
    promptDefinitions: getCovidencePromptDefinitions(body),
    title,
  }).catch((error: unknown) => {
    deleteCovidencePackageFiles(dataSourceId)
    throw error
  })

  await startCovidencePackageImportInBackground({
    config,
    dataSourceId,
    packageRows: created.packageRows,
    projectId: created.covidenceProject.id,
    title,
    trigger: 'manual',
  })

  const dataSource = await getDataSourceQueryService().getDataSourceById(dataSourceId)

  if (!dataSource) {
    throw new Error('Data source not found after Covidence import create')
  }

  return {
    success: true,
    data: {
      covidencePackageConfig: config,
      covidenceProject: created.covidenceProject,
      covidencePrompts: created.covidencePrompts,
      dataSource,
    },
  }
}
