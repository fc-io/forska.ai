import {expect, test} from 'bun:test'

import {getProjectFullTextContentLabel} from './fullTextStrategyOptions.ts'

test('the project content label names the full-text strategy, or the legacy flag it came from', () => {
  expect(
    getProjectFullTextContentLabel({
      fullTextStrategyLabel: 'mineru 4.0.12 / none / chunked 48k',
      useFulltext: true,
      useFulltextNoImages: false,
    }),
  ).toBe('fulltext (mineru 4.0.12 / none / chunked 48k)')
  expect(getProjectFullTextContentLabel({useFulltext: false, useFulltextNoImages: true})).toBe('fulltext (no images)')
  expect(getProjectFullTextContentLabel({useFulltext: true, useFulltextNoImages: false})).toBe('fulltext (legacy)')
  expect(
    getProjectFullTextContentLabel({
      fullTextStrategyLabel: 'no full text',
      useFulltext: false,
      useFulltextNoImages: false,
    }),
  ).toBeNull()
})
