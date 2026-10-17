import {expect, test} from 'bun:test'

import {getProjectFullTextContentLabel} from './fullTextStrategyOptions.ts'

test('the project content label names the full-text strategy, or the legacy flag it came from', () => {
  expect(
    getProjectFullTextContentLabel({
      fullTextStrategyId: 'fts-0123456789abcdef',
      fullTextStrategyLabel: 'mineru 4.0.12 / none / chunked 48k',
      useFulltext: true,
      useFulltextNoImages: false,
    }),
  ).toBe('fulltext (mineru 4.0.12 / none / chunked 48k)')
  expect(getProjectFullTextContentLabel({useFulltext: false, useFulltextNoImages: true})).toBe(
    'fulltext (legacy, no images)',
  )
  expect(
    getProjectFullTextContentLabel({
      fullTextStrategyId: 'fts-legacy-v0',
      fullTextStrategyLabel: 'legacy full text (before strategy tracking)',
      useFulltext: true,
      useFulltextNoImages: false,
    }),
  ).toBe('fulltext (legacy)')
  expect(
    getProjectFullTextContentLabel({
      fullTextStrategyLabel: 'no full text',
      useFulltext: false,
      useFulltextNoImages: false,
    }),
  ).toBeNull()
})
