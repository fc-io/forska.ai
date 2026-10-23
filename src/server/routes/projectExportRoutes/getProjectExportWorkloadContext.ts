export const getProjectExportWorkloadContext = (params: {
  maxResultRows?: number
  operation: string
  projectId: string
}) => {
  return {
    fallbackIntent: 'reject' as const,
    maxResultRows: params.maxResultRows,
    projectId: params.projectId,
    routeOrJobKey: `projectExport.${params.operation}`,
    workloadClass: 'owner.product.projectExport',
  }
}
