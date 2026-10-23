export const getShouldIncludeConflictResolutionStatsGroups = (params: {
  allowConflictResolution?: boolean
  isSummaryMode?: boolean
}) => {
  return Boolean(params.allowConflictResolution && params.isSummaryMode)
}
