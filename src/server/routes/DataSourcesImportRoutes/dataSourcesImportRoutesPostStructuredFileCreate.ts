import {randomUUID} from 'node:crypto'

import {getAppDatabaseService} from '../../services/appDatabaseService.ts'
import {escapeSqlString, getSqlLiteral} from '../../services/appQueryHelpers.ts'
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

  await getAppDatabaseService().run(`
    INSERT INTO app.data_source (id, title, description, import_route, cursor)
    VALUES (
      '${escapeSqlString(dataSourceId)}',
      ${getSqlLiteral(body.title)},
      ${getSqlLiteral(body.description?.trim() ? body.description : null)},
      ${getSqlLiteral(importRoute)},
      ${getSqlLiteral(cursor)}
    )
  `)

  const result = await importStructuredFileFromConfig({config, dataSourceTitle: body.title, importRoute})
  const dataSource = await getDataSourceQueryService().updateDataSourceAfterImport({
    cursor,
    id: dataSourceId,
    importRoute,
    importedCount: result.stats.importedCount,
  })

  return {success: true, data: {dataSource, stats: result.stats, structuredFileConfig: config}}
}
