import {afterEach, expect, setSystemTime, test} from 'bun:test'

import {
  getComparisonProjectCovidenceExportFilenameStem,
  getComparisonProjectCovidenceExportPartFilename,
} from './comparisonProjectCovidenceExportFilename.ts'

afterEach(() => {
  setSystemTime()
})

test('the filename stem is the safe project name, the export kind and the UTC date', () => {
  setSystemTime(new Date('2026-11-09T23:30:00Z'))

  expect(getComparisonProjectCovidenceExportFilenameStem({name: 'cov 9 | Astra'}, {invertSelection: false})).toBe(
    'cov_9___Astra_covidence_full_text_export_2026-11-09',
  )
})

test('the inverted export is named as the articles that do not match', () => {
  setSystemTime(new Date('2026-11-09T23:30:00Z'))

  expect(getComparisonProjectCovidenceExportFilenameStem({name: 'cov 9 | Astra'}, {invertSelection: true})).toBe(
    'cov_9___Astra_covidence_not_matching_export_2026-11-09',
  )
  expect(
    getComparisonProjectCovidenceExportPartFilename(
      getComparisonProjectCovidenceExportFilenameStem({name: 'cov 9'}, {invertSelection: true}),
      0,
      2,
    ),
  ).toBe('cov_9_covidence_not_matching_export_2026-11-09_part01_of_02.ris')
})

test('part filenames count from 01 and pad to the width of the part count', () => {
  expect(
    [0, 1, 2].map((partIndex) => {
      return getComparisonProjectCovidenceExportPartFilename('stem', partIndex, 3)
    }),
  ).toEqual(['stem_part01_of_03.ris', 'stem_part02_of_03.ris', 'stem_part03_of_03.ris'])
  expect(getComparisonProjectCovidenceExportPartFilename('stem', 9, 12)).toBe('stem_part10_of_12.ris')
  expect(getComparisonProjectCovidenceExportPartFilename('stem', 6, 120)).toBe('stem_part007_of_120.ris')
})
