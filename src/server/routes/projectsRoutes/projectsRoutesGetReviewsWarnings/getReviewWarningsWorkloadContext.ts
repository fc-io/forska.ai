import type {DuckdbWorkloadContext} from '../../../utils/duckdbService.ts'

export const getReviewWarningsWorkloadContext = (projectId: string, operation: string): DuckdbWorkloadContext => {
  return {
    fallbackIntent: 'serveStale',
    maxResultRows: 64,
    projectId,
    routeOrJobKey: `review.warnings.${operation}`,
    workloadClass: 'foreground-diagnostic',
  }
}
