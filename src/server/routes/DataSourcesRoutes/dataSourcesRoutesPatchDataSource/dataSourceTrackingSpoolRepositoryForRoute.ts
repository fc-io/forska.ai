import {getDataSourceTrackingSpoolRepository} from '../../../services/dataSourceTrackingSpoolRepository.ts'

type DataSourceTrackingSpoolRepositoryForRoutes = Pick<
  ReturnType<typeof getDataSourceTrackingSpoolRepository>,
  'rejectOpenWindowsForDataSource'
>
let dataSourceTrackingSpoolRepositoryForTests: DataSourceTrackingSpoolRepositoryForRoutes | null = null

export const setDataSourceTrackingSpoolRepositoryForTests = (
  repository: DataSourceTrackingSpoolRepositoryForRoutes | null,
) => {
  dataSourceTrackingSpoolRepositoryForTests = repository
}

export const getDataSourceTrackingSpoolRepositoryForRoute = () => {
  return dataSourceTrackingSpoolRepositoryForTests ?? getDataSourceTrackingSpoolRepository()
}
