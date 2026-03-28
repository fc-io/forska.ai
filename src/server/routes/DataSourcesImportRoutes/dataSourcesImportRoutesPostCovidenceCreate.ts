import {randomUUID} from 'node:crypto'

import {getAppDatabaseService} from '../../services/appDatabaseService.ts'
import {escapeSqlString, getSqlLiteral, getTimestampLiteral} from '../../services/appQueryHelpers.ts'
import {queueImportedArticleRefreshes} from '../../services/articleImportStoreService.ts'
import {
  buildCovidencePackageConfig,
  deleteCovidencePackageFiles,
  getCovidencePackageCursor,
  getOrCreateCovidenceProject,
  getOrCreateCovidencePrompt,
  importCovidencePackageFromConfig,
  seedCovidenceHumanJudgmentsFromConfig,
  storeCovidencePackageFiles,
} from '../../services/covidenceImportService.ts'
import {getDataSourceQueryService} from '../../services/dataSourceQueryService.ts'
import {getDuckdbMartRefreshService} from '../../services/getDuckdbMartRefreshService.ts'

type CovidenceImportMode = 'title_abstract' | 'full_text'
type CovidenceFileRole = 'all' | 'irrelevant' | 'full_text' | 'excluded' | 'included'
type CovidencePromptAnswerSet = 'yes|no' | 'yes|no|unsure' | 'yes_no' | 'yes_no_unsure'
type CovidencePackageUploadInput = Blob & {name?: string; type?: string}

export const dataSourcesImportRoutesPostCovidenceCreate = async (body: {
  title: string
  description?: string
  answerSet?: CovidencePromptAnswerSet
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
  const covidencePromptInput =
    typeof body.answerSet === 'string'
    && typeof body.inclusionCriteria === 'string'
    && typeof body.exclusionCriteria === 'string'
      ? {
          answerSet: body.answerSet,
          exclusionCriteria: body.exclusionCriteria,
          inclusionCriteria: body.inclusionCriteria,
          mode: body.mode,
        }
      : null
  const result = (await getAppDatabaseService()
    .transaction(async (tx) => {
      const covidencePrompt = covidencePromptInput
        ? await getOrCreateCovidencePrompt({...covidencePromptInput, tx})
        : null

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

      const covidenceProject =
        body.mode === 'title_abstract'
          ? await getOrCreateCovidenceProject({
              importRoute,
              mode: body.mode,
              promptId: covidencePrompt?.id ?? null,
              title,
              tx,
            })
          : null

      await seedCovidenceHumanJudgmentsFromConfig({config, importRoute, projectId: covidenceProject?.id ?? null, tx})

      return {...importResult, covidenceProject, covidencePrompt}
    })
    .catch(async (error) => {
      deleteCovidencePackageFiles(dataSourceId)
      throw error
    })) as Awaited<ReturnType<typeof importCovidencePackageFromConfig>>

  await queueImportedArticleRefreshes(result.importRouteIds ?? [])
  await getDuckdbMartRefreshService().queueProjectRefreshesByImportRouteIds(
    result.importRouteIds ?? [],
    'covidenceCreateImportRouteRefresh',
  )

  const dataSource = await getDataSourceQueryService().getDataSourceById(dataSourceId)

  if (!dataSource) {
    throw new Error('Data source not found after Covidence import create')
  }

  return {
    success: true,
    data: {
      covidencePackageConfig: config,
      covidenceProject: 'covidenceProject' in result ? result.covidenceProject : null,
      covidencePrompt: 'covidencePrompt' in result ? result.covidencePrompt : null,
      dataSource,
      stats: result.stats,
    },
  }
}
