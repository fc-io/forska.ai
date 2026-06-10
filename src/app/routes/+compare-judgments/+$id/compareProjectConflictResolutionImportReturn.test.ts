import {describe, expect, test} from 'bun:test'

import {
  getConflictResolutionImportCommittedSearchParams,
  getConflictResolutionImportRefreshQueryKeys,
  getHasConflictResolutionImportCommittedSearchParam,
} from './compareProjectConflictResolutionImportReturn.ts'

describe('compare project conflict resolution import return helpers', () => {
  test('marks the comparison detail return after a committed import', () => {
    expect(getConflictResolutionImportCommittedSearchParams()).toEqual({importedResolutions: '1'})
    expect(getHasConflictResolutionImportCommittedSearchParam({importedResolutions: '1'})).toBe(true)
    expect(getHasConflictResolutionImportCommittedSearchParam({importedResolutions: ['0', '1']})).toBe(true)
    expect(getHasConflictResolutionImportCommittedSearchParam({importedResolutions: '0'})).toBe(false)
  })

  test('targets the comparison detail queries that show imported resolutions', () => {
    expect(getConflictResolutionImportRefreshQueryKeys('comparison-project-1')).toEqual([
      ['comparison-project-judgments-page', 'comparison-project-1'],
      ['comparison-project-judgments-count', 'comparison-project-1'],
      ['comparison-project-stats', 'comparison-project-1'],
    ])
  })
})
