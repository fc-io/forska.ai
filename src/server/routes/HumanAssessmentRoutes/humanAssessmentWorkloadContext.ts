export const getHumanAssessmentWorkloadContext = ({
  maxResultRows,
  operation,
  projectId,
}: {
  maxResultRows?: number
  operation: string
  projectId?: string
}) => {
  return {
    fallbackIntent: 'reject' as const,
    maxResultRows,
    projectId,
    routeOrJobKey: `humanAssessment.${operation}`,
    workloadClass: 'owner.product.humanAssessment',
  }
}
