import {randomUUID} from 'node:crypto'

import {getAppDatabaseService} from '../../services/appDatabaseService.ts'
import {escapeSqlString, getSqlLiteral, getTimestampLiteral} from '../../services/appQueryHelpers.ts'
import {queueImportedArticleRefreshes} from '../../services/articleImportStoreService.ts'
import {getDataSourceQueryService} from '../../services/dataSourceQueryService.ts'
import {
  buildStructuredFileImportConfig,
  getStructuredFileImportCursor,
  importStructuredFileFromConfig,
} from '../../services/structuredFileImportService.ts'

type StructuredFileFormat = 'json' | 'xml'

export const dataSourcesImportRoutesPostStructuredFileCreate = async (body: {
  title: string
  description?: string
  assetPath: string
  sourceFileName: string
  format: StructuredFileFormat
  boundaryPointer: string
  boundaryDisplayPath: string
}) => {
  const dataSourceId = randomUUID()
  const importRoute = `structured-file:${dataSourceId}`
  const config = buildStructuredFileImportConfig({
    assetPath: body.assetPath,
    boundaryDisplayPath: body.boundaryDisplayPath,
    boundaryPointer: body.boundaryPointer,
    format: body.format,
    sourceFileName: body.sourceFileName,
  })
  const cursor = getStructuredFileImportCursor(config)
  const result = (await getAppDatabaseService().transaction(async (tx) => {
    await tx.run(`
      INSERT INTO app.data_source (id, title, description, import_route, cursor)
      VALUES (
        '${escapeSqlString(dataSourceId)}',
        ${getSqlLiteral(body.title)},
        ${getSqlLiteral(body.description?.trim() ? body.description : null)},
        ${getSqlLiteral(importRoute)},
        ${getSqlLiteral(cursor)}
      )
    `)

    const importResult = await importStructuredFileFromConfig({config, dataSourceTitle: body.title, importRoute, tx})
    const updatedAt = new Date()

    await tx.run(`
      UPDATE app.data_source
      SET last_import_at = ${getTimestampLiteral(updatedAt)},
          items_after_last_import = ${importResult.stats.importedCount},
          updated_at = ${getTimestampLiteral(updatedAt)},
          import_route = ${getSqlLiteral(importRoute)},
          cursor = ${getSqlLiteral(cursor)}
      WHERE id = '${escapeSqlString(dataSourceId)}'
    `)

    return importResult
  })) as Awaited<ReturnType<typeof importStructuredFileFromConfig>>

  await queueImportedArticleRefreshes(result.importRouteIds ?? [])

  const dataSource = await getDataSourceQueryService().getDataSourceById(dataSourceId)

  if (!dataSource) {
    throw new Error('Data source not found after structured file import')
  }

  return {success: true, data: {dataSource, stats: result.stats, structuredFileConfig: config}}
}
