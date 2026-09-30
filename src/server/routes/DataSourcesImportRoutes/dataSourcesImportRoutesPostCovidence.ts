import {getCovidencePackageConfig, getCovidencePackageRowsFromConfig} from '../../services/covidenceImportService.ts'
import type {DataSourceImportTrigger} from '../../services/dataSourceImportStateRepository.ts'
import {getDataSourceQueryService} from '../../services/dataSourceQueryService.ts'
import {HttpError} from '../../utils/httpError.ts'
import {startCovidencePackageImportInBackground} from './startCovidencePackageImportInBackground.ts'

export const dataSourcesImportRoutesPostCovidence = async (
  body: {id: string},
  options: {trigger?: DataSourceImportTrigger} = {},
) => {
  const dataSourceQueryService = getDataSourceQueryService()
  const dataSource = await dataSourceQueryService.getDataSourceById(body.id)

  if (!dataSource) {
    throw new HttpError(404, 'Data source not found')
  }

  const config = getCovidencePackageConfig(dataSource.cursor)

  if (!config) {
    throw new HttpError(400, 'Data source is not configured for Covidence import')
  }

  await startCovidencePackageImportInBackground({
    config,
    dataSourceId: dataSource.id,
    packageRows: getCovidencePackageRowsFromConfig(config),
    projectId: null,
    title: dataSource.title,
    trigger: options.trigger ?? 'manual',
  })

  return {success: true, data: await dataSourceQueryService.getDataSourceById(dataSource.id)}
}
