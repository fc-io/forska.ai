import {requestReviewServingV4Rebuild} from '../../reviewServing/reviewServingV4RebuildRequestService.ts'
import {getAppDatabaseService} from '../../services/appDatabaseService.ts'
import {escapeSqlString, getSqlLiteral, getTimestampLiteral} from '../../services/appQueryHelpers.ts'
import {
  type ArticleImportBatchProgress,
  type ArticleImportStoreTx,
  articleImportStoreWorkloadContext,
} from '../../services/articleImportStoreService.ts'
import {
  clearCovidenceSeededHumanJudgments,
  type CovidencePackageConfig,
  type CovidenceReferenceMergeResult,
  getCovidencePackageCursor,
  importCovidencePackageInBatches,
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

const runCovidenceImportTransaction = <T>(work: (tx: ArticleImportStoreTx) => Promise<T>) => {
  return getAppDatabaseService().transaction(work, articleImportStoreWorkloadContext)
}

const recordCovidencePackageImportProgress = async (dataSourceId: string, progress: ArticleImportBatchProgress) => {
  await getAppDatabaseService().run(
    getDataSourceImportPageSavedSql({
      dataSourceId,
      now: new Date(),
      progress: {
        runFetchedCount: progress.storedCount,
        runStoredCount: progress.storedCount,
        totalCount: progress.totalCount,
      },
    }),
    getDataSourceImportStateWorkloadContext('markRunProgress'),
  )
}

const finalizeCovidencePackageImport = async (input: CovidencePackageImportRun, importedCount: number) => {
  const importRoute = getCovidenceImportRoute(input.dataSourceId)
  const cursor = getCovidencePackageCursor(input.config)
  const updatedAt = new Date()

  await runCovidenceImportTransaction(async (tx) => {
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
  })
}

const runCovidencePackageImport = async (input: CovidencePackageImportRun) => {
  const importRoute = getCovidenceImportRoute(input.dataSourceId)

  await recordCovidencePackageImportProgress(input.dataSourceId, {
    storedCount: 0,
    totalCount: input.packageRows.candidates.length,
  })
  await runCovidenceImportTransaction(async (tx) => {
    await clearCovidenceSeededHumanJudgments({importRoute, tx})
  })

  const importResult = await importCovidencePackageInBatches({
    config: input.config,
    importRoute,
    onBatchStored: (progress) => {
      return recordCovidencePackageImportProgress(input.dataSourceId, progress)
    },
    packageRows: input.packageRows,
  })

  await runCovidenceImportTransaction(async (tx) => {
    await syncCovidenceProjectScopeFromConfig({
      config: input.config,
      importRoute,
      packageRows: importResult.packageRows,
      projectId: input.projectId,
      tx,
    })
  })
  await runCovidenceImportTransaction(async (tx) => {
    await seedCovidenceHumanJudgmentsFromConfig({
      config: input.config,
      importRoute,
      packageRows: importResult.packageRows,
      projectId: input.projectId,
      tx,
    })
  })
  await finalizeCovidencePackageImport(input, importResult.stats.importedCount)

  return importResult.stats
}

export const startCovidencePackageImportInBackground = async (input: CovidencePackageImportRun) => {
  await startDataSourceImportInBackground({
    dataSourceId: input.dataSourceId,
    importRoute: getCovidenceImportRoute(input.dataSourceId),
    startsFresh: true,
    trigger: input.trigger,
    runImport: async (markImportStarted) => {
      await markImportStarted()

      const stats = await runCovidencePackageImport(input)

      requestCovidenceProjectReviewServingBootstrap(input.projectId)

      return stats
    },
  })
}
