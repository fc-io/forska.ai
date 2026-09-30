import {requestReviewServingV4Rebuild} from '../../reviewServing/reviewServingV4RebuildRequestService.ts'
import {getAppDatabaseService} from '../../services/appDatabaseService.ts'
import {escapeSqlString, getSqlLiteral, getTimestampLiteral} from '../../services/appQueryHelpers.ts'
import {articleImportStoreWorkloadContext} from '../../services/articleImportStoreService.ts'
import {
  clearCovidenceSeededHumanJudgments,
  type CovidencePackageConfig,
  type CovidenceReferenceMergeResult,
  getCovidencePackageCursor,
  importCovidencePackageFromConfig,
  seedCovidenceHumanJudgmentsFromConfig,
  syncCovidenceProjectScopeFromConfig,
} from '../../services/covidenceImportService.ts'
import {
  type DataSourceImportTrigger,
  getDataSourceImportCompletedSql,
  getDataSourceImportPageSavedSql,
  getDataSourceImportStateWorkloadContext,
} from '../../services/dataSourceImportStateRepository.ts'
import {startDataSourceImportInBackground} from './startDataSourceImportInBackground.ts'

type CovidencePackageImportRun = {
  config: CovidencePackageConfig
  dataSourceId: string
  packageRows: CovidenceReferenceMergeResult
  projectId: string | null
  title: string
  trigger: DataSourceImportTrigger
}

export const covidenceImportRoutePrefix = 'covidence:'

export const getCovidenceImportRoute = (dataSourceId: string) => {
  return `${covidenceImportRoutePrefix}${dataSourceId}`
}

export const isCovidenceImportRoute = (importRoute: string | null | undefined) => {
  return importRoute?.startsWith(covidenceImportRoutePrefix) ?? false
}

const getCanRequestReviewServingBootstrap = () => {
  return typeof (getAppDatabaseService() as {queryJson?: unknown}).queryJson === 'function'
}

const requestCovidenceProjectReviewServingBootstrap = (projectId: string | null) => {
  if (projectId === null || !getCanRequestReviewServingBootstrap()) {
    return
  }

  requestReviewServingV4Rebuild({projectId, reason: 'missingReviewServingSnapshot'}).catch(() => {
    return undefined
  })
}

const recordCovidencePackageImportTotal = async (input: CovidencePackageImportRun) => {
  const totalCount = input.packageRows.candidates.length

  await getAppDatabaseService().run(
    getDataSourceImportPageSavedSql({
      dataSourceId: input.dataSourceId,
      now: new Date(),
      progress: {runFetchedCount: 0, runStoredCount: 0, totalCount},
    }),
    getDataSourceImportStateWorkloadContext('markRunTotal'),
  )
}

const runCovidencePackageImportTransaction = async (input: CovidencePackageImportRun) => {
  const importRoute = getCovidenceImportRoute(input.dataSourceId)
  const cursor = getCovidencePackageCursor(input.config)

  return await getAppDatabaseService().transaction(async (tx) => {
    await clearCovidenceSeededHumanJudgments({importRoute, tx})

    const importResult = await importCovidencePackageFromConfig({
      config: input.config,
      datasourceId: input.dataSourceId,
      importRoute,
      packageRows: input.packageRows,
      tx,
    })
    const importedCount = importResult.stats.importedCount
    const updatedAt = new Date()

    await syncCovidenceProjectScopeFromConfig({
      config: input.config,
      importRoute,
      packageRows: importResult.packageRows,
      projectId: input.projectId,
      tx,
    })
    await seedCovidenceHumanJudgmentsFromConfig({
      config: input.config,
      importRoute,
      packageRows: importResult.packageRows,
      projectId: input.projectId,
      tx,
    })

    await tx.run(`
      UPDATE app.import_route
      SET name = ${getSqlLiteral(input.title)}
      WHERE route = ${getSqlLiteral(importRoute)}
    `)

    await tx.run(`
      UPDATE app.data_source
      SET last_import_at = ${getTimestampLiteral(updatedAt)},
          items_after_last_import = ${importedCount},
          updated_at = ${getTimestampLiteral(updatedAt)},
          import_route = ${getSqlLiteral(importRoute)},
          cursor = ${getSqlLiteral(cursor)}
      WHERE id = '${escapeSqlString(input.dataSourceId)}'
    `)

    await tx.run(
      getDataSourceImportPageSavedSql({
        dataSourceId: input.dataSourceId,
        now: updatedAt,
        progress: {runFetchedCount: importedCount, runStoredCount: importedCount, totalCount: importedCount},
      }),
    )
    await tx.run(getDataSourceImportCompletedSql({dataSourceId: input.dataSourceId, now: updatedAt}))

    return importResult.stats
  }, articleImportStoreWorkloadContext)
}

export const startCovidencePackageImportInBackground = async (input: CovidencePackageImportRun) => {
  await startDataSourceImportInBackground({
    dataSourceId: input.dataSourceId,
    importRoute: getCovidenceImportRoute(input.dataSourceId),
    startsFresh: true,
    trigger: input.trigger,
    runImport: async (markImportStarted) => {
      await markImportStarted()
      await recordCovidencePackageImportTotal(input)

      const stats = await runCovidencePackageImportTransaction(input)

      requestCovidenceProjectReviewServingBootstrap(input.projectId)

      return stats
    },
  })
}
