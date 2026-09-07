import {describe, expect, test} from 'bun:test'

const {compareProjectResolutionImportDisabledCopy, getImportResolutionsHref} =
  require('./compareProjectResolutionTransferActions.tsx') as typeof import('./compareProjectResolutionTransferActions.tsx')

describe('compare detail resolution transfer actions', () => {
  test('builds the import resolutions entry point href', () => {
    expect(getImportResolutionsHref('comparison-project-1')).toBe(
      '/compare-judgments/comparison-project-1/import-resolutions',
    )
  })

  test('keeps disabled import copy explicit', () => {
    expect(compareProjectResolutionImportDisabledCopy).toBe(
      'Target comparison project must allow conflict resolution to import resolutions.',
    )
  })
})
