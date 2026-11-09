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

test('the button label keeps counting articles above the per-file limit', () => {
  expect(getCompareProjectCovidenceExportButtonLabel(15_666, false)).toBe(
    `Export ${(15_666).toLocaleString()} articles to Covidence`,
  )
  expect(getCompareProjectCovidenceExportButtonLabel(15_666, true)).toBe('Exporting to Covidence...')
})
