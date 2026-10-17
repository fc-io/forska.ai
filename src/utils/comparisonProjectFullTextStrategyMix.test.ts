import {expect, test} from 'bun:test'

import {
  type ComparisonProjectFullTextStrategySource,
  getComparisonProjectFullTextStrategyMixError,
} from './comparisonProjectFullTextStrategyMix.ts'
import type {FullTextStrategyInputs} from './fullTextStrategyOptions.ts'

const baseInputs: FullTextStrategyInputs = {
  canonicalTextVersion: 'canonical-v1',
  chunkPolicy: {maxPromptTokens: 96_000, mode: 'single_only'},
  converterKind: 'mineru',
  converterOptionsHash: 'options-hash',
  converterVersion: '4.0.0',
  figureDescriptionModelId: null,
  figureDescriptionPromptVersion: null,
  figureMode: 'none',
  imageTransportVersion: null,
  promptLayoutVersion: 'layout-v1',
  tokenizerId: 'o200k_base',
}

const getSource = (
  name: string,
  fullTextStrategyId: string,
  fullTextStrategyInputs: FullTextStrategyInputs | null,
): ComparisonProjectFullTextStrategySource => {
  return {fullTextStrategyId, fullTextStrategyInputs, fullTextStrategyLabel: `${name} label`, name}
}

test('accepts projects that share one full-text strategy', () => {
  expect(
    getComparisonProjectFullTextStrategyMixError([
      getSource('A', 'fts-aaaaaaaaaaaaaaaa', baseInputs),
      getSource('B', 'fts-aaaaaaaaaaaaaaaa', baseInputs),
    ]),
  ).toBeNull()
  expect(getComparisonProjectFullTextStrategyMixError([getSource('A', 'fts-none', null)])).toBeNull()
  expect(getComparisonProjectFullTextStrategyMixError([])).toBeNull()
})

test('lists every project and the differing strategy inputs', () => {
  expect(
    getComparisonProjectFullTextStrategyMixError([
      getSource('A', 'fts-aaaaaaaaaaaaaaaa', baseInputs),
      getSource('B', 'fts-bbbbbbbbbbbbbbbb', {...baseInputs, figureMode: 'descriptions'}),
      getSource('C', 'fts-cccccccccccccccc', {
        ...baseInputs,
        chunkPolicy: {maxPromptTokens: 48_000, mode: 'single_only'},
      }),
    ]),
  ).toBe(
    'Selected projects use different full-text strategies: A: A label; B: B label; C: C label. Differing inputs: figureMode, chunkPolicy',
  )
})

test('names full text as the differing input when a reserved strategy is involved', () => {
  expect(
    getComparisonProjectFullTextStrategyMixError([
      getSource('A', 'fts-none', null),
      getSource('B', 'fts-bbbbbbbbbbbbbbbb', baseInputs),
    ]),
  ).toBe('Selected projects use different full-text strategies: A: A label; B: B label. Differing inputs: full text')
  expect(
    getComparisonProjectFullTextStrategyMixError([
      getSource('A', 'fts-legacy-v0', baseInputs),
      getSource('B', 'fts-bbbbbbbbbbbbbbbb', baseInputs),
    ]),
  ).toBe('Selected projects use different full-text strategies: A: A label; B: B label. Differing inputs: full text')
})
