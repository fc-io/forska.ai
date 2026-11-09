import {expect, test} from 'bun:test'

import {
  getCompareProjectCovidenceExportButtonLabel,
  getCompareProjectCovidenceExportHint,
} from './compareProjectCovidenceExportLabels.ts'

const getSplitHint = (fileCount: number) => {
  return `Covidence imports at most ${(15_000).toLocaleString()} references per file, so the download is a ZIP with ${fileCount} RIS files. Import each file separately.`
}

test('the hint says why nothing can be exported', () => {
  expect(getCompareProjectCovidenceExportHint(false, null)).toBe('Nothing is selected, so there is nothing to export.')
  expect(getCompareProjectCovidenceExportHint(false, 20_000)).toBe(
    'Nothing is selected, so there is nothing to export.',
  )
  expect(getCompareProjectCovidenceExportHint(true, 0)).toBe('No articles match this selection.')
})

test('the hint stays empty up to 15,000 articles and while the count loads', () => {
  expect(getCompareProjectCovidenceExportHint(true, null)).toBeNull()
  expect(getCompareProjectCovidenceExportHint(true, 1)).toBeNull()
  expect(getCompareProjectCovidenceExportHint(true, 15_000)).toBeNull()
})

test('above 15,000 articles the hint names the number of RIS files in the ZIP', () => {
  expect(getCompareProjectCovidenceExportHint(true, 15_001)).toBe(getSplitHint(2))
  expect(getCompareProjectCovidenceExportHint(true, 15_666)).toBe(getSplitHint(2))
  expect(getCompareProjectCovidenceExportHint(true, 30_000)).toBe(getSplitHint(2))
  expect(getCompareProjectCovidenceExportHint(true, 30_001)).toBe(getSplitHint(3))
})

test('the inverted hint counts the articles that do not match the selection', () => {
  expect(getCompareProjectCovidenceExportHint(true, 3, true)).toBe(
    'Inverted: 3 articles do not match the selection above.',
  )
  expect(getCompareProjectCovidenceExportHint(true, 1, true)).toBe(
    'Inverted: 1 article does not match the selection above.',
  )
  expect(getCompareProjectCovidenceExportHint(true, 0, true)).toBe(
    'Inverted: 0 articles do not match the selection above.',
  )
  expect(getCompareProjectCovidenceExportHint(true, 15_000, true)).toBe(
    `Inverted: ${(15_000).toLocaleString()} articles do not match the selection above.`,
  )
  expect(getCompareProjectCovidenceExportHint(true, null, true)).toBeNull()
  expect(getCompareProjectCovidenceExportHint(true, 3, false)).toBeNull()
})

test('above 15,000 articles the inverted hint adds the ZIP hint', () => {
  expect(getCompareProjectCovidenceExportHint(true, 15_001, true)).toBe(
    `Inverted: ${(15_001).toLocaleString()} articles do not match the selection above. ${getSplitHint(2)}`,
  )
  expect(getCompareProjectCovidenceExportHint(true, 30_001, true)).toBe(
    `Inverted: ${(30_001).toLocaleString()} articles do not match the selection above. ${getSplitHint(3)}`,
  )
})

test('with nothing selected the inverted hint still says there is nothing to export', () => {
  expect(getCompareProjectCovidenceExportHint(false, null, true)).toBe(
    'Nothing is selected, so there is nothing to export.',
  )
  expect(getCompareProjectCovidenceExportHint(false, 0, true)).toBe(
    'Nothing is selected, so there is nothing to export.',
  )
})

test('the button label keeps counting articles above the per-file limit', () => {
  expect(getCompareProjectCovidenceExportButtonLabel(15_666, false)).toBe(
    `Export ${(15_666).toLocaleString()} articles to Covidence`,
  )
  expect(getCompareProjectCovidenceExportButtonLabel(15_666, true)).toBe('Exporting to Covidence...')
})
