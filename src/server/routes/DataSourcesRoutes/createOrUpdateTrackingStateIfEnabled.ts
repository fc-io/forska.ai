import {
  createDataSourceTrackingRepository,
  type DataSourceTrackingDatabaseRunner,
} from '../../services/dataSourceTrackingRepository.ts'

export const createOrUpdateTrackingStateIfEnabled = async (params: {
  db: DataSourceTrackingDatabaseRunner
  dataSourceId: string
  importRoute: string | null
  trackingEnabled: boolean
}) => {
  if (!params.trackingEnabled || !params.importRoute) {
    return
  }

  await createDataSourceTrackingRepository(params.db).createOrUpdateTrackingState({
    dataSourceId: params.dataSourceId,
    granularity: 'day',
    route: params.importRoute,
  })
}
