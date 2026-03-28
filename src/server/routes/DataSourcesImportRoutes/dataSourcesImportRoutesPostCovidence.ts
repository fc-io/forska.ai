import type {Context} from 'elysia'

import {getAppDatabaseService} from '../../services/appDatabaseService.ts'
import {escapeSqlString, getSqlLiteral, getTimestampLiteral} from '../../services/appQueryHelpers.ts'
import {queueImportedArticleRefreshes} from '../../services/articleImportStoreService.ts'
import {
  clearCovidenceSeededHumanJudgments,
  getCovidencePackageConfig,
  getCovidencePackageCursor,
  importCovidencePackageFromConfig,
  seedCovidenceHumanJudgmentsFromConfig,
} from '../../services/covidenceImportService.ts'
import {getDataSourceQueryService} from '../../services/dataSourceQueryService.ts'
import {getDuckdbMartRefreshService} from '../../services/getDuckdbMartRefreshService.ts'

export const dataSourcesImportRoutesPostCovidence = async ({body, set}: {body: {id: string}; set: Context['set']}) => {
  const dataSource = await getDataSourceQueryService().getDataSourceById(body.id)

  if (!dataSource) {
    set.status = 404
    return {data: null, error: 'Data source not found'}
  }

  const config = getCovidencePackageConfig(dataSource.cursor)

  if (!config) {
    set.status = 400
    return {data: null, error: 'Data source is not configured for Covidence import'}
  }

  const importRoute = `covidence:${dataSource.id}`
  const cursor = getCovidencePackageCursor(config)
  const result = (await getAppDatabaseService().transaction(async (tx) => {
    await clearCovidenceSeededHumanJudgments({importRoute, tx})
    const importResult = await importCovidencePackageFromConfig({config, datasourceId: dataSource.id, importRoute, tx})
    const updatedAt = new Date()

    await seedCovidenceHumanJudgmentsFromConfig({config, importRoute, tx})

    await tx.run(`
      UPDATE app.import_route
      SET name = ${getSqlLiteral(dataSource.title)}
      WHERE route = ${getSqlLiteral(importRoute)}
    `)

    await tx.run(`
      UPDATE app.data_source
      SET last_import_at = ${getTimestampLiteral(updatedAt)},
          items_after_last_import = ${importResult.stats.importedCount},
          updated_at = ${getTimestampLiteral(updatedAt)},
          import_route = ${getSqlLiteral(importRoute)},
          cursor = ${getSqlLiteral(cursor)}
      WHERE id = '${escapeSqlString(dataSource.id)}'
    `)

    return importResult
  })) as Awaited<ReturnType<typeof importCovidencePackageFromConfig>>

  await queueImportedArticleRefreshes(result.importRouteIds ?? [])
  await getDuckdbMartRefreshService().queueProjectRefreshesByImportRouteIds(
    result.importRouteIds ?? [],
    'covidenceImportRouteRefresh',
  )

  return {success: true, data: await getDataSourceQueryService().getDataSourceById(dataSource.id), stats: result.stats}
}
