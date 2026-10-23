import type {DuckdbWorkloadContext} from '../../utils/duckdbService.ts'

export const getDataSourcesWorkloadContext = ({
  maxResultRows,
  operation,
}: {
  maxResultRows?: number
  operation: string
}): DuckdbWorkloadContext => {
  return {
    fallbackIntent: 'reject',
    maxResultRows,
    routeOrJobKey: `dataSources.${operation}`,
    workloadClass: 'owner.product.dataSources',
  }
}
