export const getPromptPreviewWorkloadContext = (params: {
  maxResultRows?: number
  operation: string
  projectId: string
}) => {
  return {
    fallbackIntent: 'reject' as const,
    maxResultRows: params.maxResultRows,
    projectId: params.projectId,
    routeOrJobKey: `projects.promptPreview.${params.operation}`,
    workloadClass: 'owner.product.promptPreview',
  }
}
