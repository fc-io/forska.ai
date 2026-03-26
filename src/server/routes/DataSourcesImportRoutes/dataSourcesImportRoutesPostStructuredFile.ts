import type {Context} from 'elysia'

import {getDataSourceQueryService} from '../../services/dataSourceQueryService.ts'
import {getStructuredFileImportConfig} from '../../services/structuredFileImportService.ts'

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

  set.status = 400
  return {data: null, error: 'Imported XML/JSON data sources are immutable and can only be archived'}
}
