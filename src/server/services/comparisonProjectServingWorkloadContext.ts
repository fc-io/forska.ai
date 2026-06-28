import type {DuckdbWorkloadContext} from '../utils/duckdbService.ts'

export const getComparisonProjectServingWorkloadContext = ({
  maxResultRows,
  routeOrJobKey,
}: {
  maxResultRows?: number
  routeOrJobKey: string
}): DuckdbWorkloadContext => {
  return {fallbackIntent: 'reject', maxResultRows, routeOrJobKey, workloadClass: 'owner.comparisonServing'}
}
