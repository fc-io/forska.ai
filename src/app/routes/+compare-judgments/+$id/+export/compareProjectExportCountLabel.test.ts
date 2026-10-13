import {expect, test} from 'bun:test'

import {getCompareProjectExportCountLabel} from './compareProjectExportCountLabel.ts'

test('compare export count label shows a counting state while the filtered count is unknown', () => {
  expect(getCompareProjectExportCountLabel(null)).toBe('Counting articles…')
})

test('compare export count label pluralizes the filtered article count', () => {
  expect(getCompareProjectExportCountLabel(0)).toBe('0 articles')
  expect(getCompareProjectExportCountLabel(1)).toBe('1 article')
  expect(getCompareProjectExportCountLabel(2)).toBe('2 articles')
  expect(getCompareProjectExportCountLabel(1234)).toBe(`${(1234).toLocaleString()} articles`)
})
