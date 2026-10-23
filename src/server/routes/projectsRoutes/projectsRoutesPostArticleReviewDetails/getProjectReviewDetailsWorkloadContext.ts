export const getProjectReviewDetailsWorkloadContext = (params: {
  maxResultRows?: number
  operation: string
  projectId: string
}) => {
  return {
    fallbackIntent: 'reject' as const,
    maxResultRows: params.maxResultRows,
    projectId: params.projectId,
    routeOrJobKey: `projects.reviewDetails.${params.operation}`,
    workloadClass: 'owner.product.reviewDetails',
  }
}
