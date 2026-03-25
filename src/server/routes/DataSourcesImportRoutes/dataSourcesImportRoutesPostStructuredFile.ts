import type {Context} from 'elysia'

import {getDataSourceQueryService} from '../../services/dataSourceQueryService.ts'
import {
  getStructuredFileImportConfig,
  importStructuredFileFromConfig,
} from '../../services/structuredFileImportService.ts'

export const dataSourcesImportRoutesPostStructuredFile = async ({
  body,
  set,
}: {
  body: {id: string}
  set: Context['set']
}) => {
  const dataSource = await getDataSourceQueryService().getDataSourceById(body.id)

  if (!dataSource) {
    set.status = 404
    return {data: null, error: 'Data source not found'}
  }

  const config = getStructuredFileImportConfig(dataSource.cursor)

  if (!config) {
    set.status = 400
    return {data: null, error: 'Data source is not configured for structured file import'}
  }

  const importRoute = dataSource.importRoute ?? `structured-file:${dataSource.id}`
  const result = await importStructuredFileFromConfig({config, dataSourceTitle: dataSource.title, importRoute})
  const updated = await getDataSourceQueryService().updateDataSourceAfterImport({
    cursor: dataSource.cursor,
    id: dataSource.id,
    importRoute,
    importedCount: result.stats.importedCount,
  })

  return {success: true, data: {dataSource: updated, stats: result.stats, structuredFileConfig: config}}
}
