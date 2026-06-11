export const conflictResolutionImportCommittedSearchParam = 'importedResolutions'
export const conflictResolutionImportCommittedSearchValue = '1'

export const getConflictResolutionImportCommittedSearchParams = () => {
  return {[conflictResolutionImportCommittedSearchParam]: conflictResolutionImportCommittedSearchValue}
}

const getSearchParamValues = (value: unknown): unknown[] => {
  return Array.isArray(value)
    ? value.map((item: unknown) => {
        return item
      })
    : [value]
}

export const getHasConflictResolutionImportCommittedSearchParam = (search: Record<string, unknown>) => {
  return getSearchParamValues(search[conflictResolutionImportCommittedSearchParam]).some((value) => {
    return value === conflictResolutionImportCommittedSearchValue || value === true
  })
}

export const getConflictResolutionImportRefreshQueryKeys = (comparisonProjectId: string) => {
  return [
    ['comparison-project-judgments-page', comparisonProjectId],
    ['comparison-project-judgments-count', comparisonProjectId],
    ['comparison-project-judgments-metadata', comparisonProjectId],
    ['comparison-project-stats', comparisonProjectId],
  ] as const
}
