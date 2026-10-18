import {createHash} from 'node:crypto'

import {expect, test} from 'bun:test'

import {
  FULL_TEXT_PROMPT_LAYOUT_VERSION,
  FULL_TEXT_STRATEGY_LEGACY,
  FULL_TEXT_STRATEGY_NONE,
  FULL_TEXT_TOKENIZER_ID,
  type FullTextStrategyInputs,
  getEffectiveFullTextStrategyId,
  getFullTextChunkPolicy,
  getFullTextStrategy,
  getFullTextStrategyDisplayLabel,
  getFullTextStrategyId,
  getFullTextStrategyInputDifferences,
  getFullTextStrategyLabel,
  getFullTextStrategyStableJson,
  getLegacyFullTextStrategyId,
  getProjectFullTextStrategyIdSql,
} from './fullTextStrategy.ts'

const frozenInputs: FullTextStrategyInputs = {
  canonicalTextVersion: 'canonical-v1',
  chunkPolicy: {maxPromptTokens: 48_000, mode: 'chunked'},
  converterKind: 'mineru',
  converterOptionsHash: 'a'.repeat(64),
  converterVersion: '4.0.12',
  figureMode: 'none',
  imageTransportVersion: null,
  promptLayoutVersion: 'layout-v1',
  tokenizerId: 'o200k_base',
}

const frozenStableJson =
  '{"canonicalTextVersion":"canonical-v1","chunkPolicy":{"maxPromptTokens":48000,"mode":"chunked"},'
  + '"converterKind":"mineru","converterOptionsHash":"'
  + 'a'.repeat(64)
  + '","converterVersion":"4.0.12",'
  + '"figureMode":"none",'
  + '"imageTransportVersion":null,"promptLayoutVersion":"layout-v1","tokenizerId":"o200k_base"}'

test('the shipped tokenizer and prompt layout constants are frozen', () => {
  expect(FULL_TEXT_TOKENIZER_ID).toBe('o200k_base')
  expect(FULL_TEXT_PROMPT_LAYOUT_VERSION).toBe('layout-v2')
  expect(FULL_TEXT_STRATEGY_NONE).toBe('fts-none')
  expect(FULL_TEXT_STRATEGY_LEGACY).toBe('fts-legacy-v0')
})

test('the stable JSON sorts keys at every level', () => {
  expect(getFullTextStrategyStableJson(frozenInputs)).toBe(frozenStableJson)
  expect(
    getFullTextStrategyStableJson({
      tokenizerId: 'o200k_base',
      promptLayoutVersion: 'layout-v1',
      imageTransportVersion: null,
      figureMode: 'none',
      converterVersion: '4.0.12',
      converterOptionsHash: 'a'.repeat(64),
      converterKind: 'mineru',
      chunkPolicy: {mode: 'chunked', maxPromptTokens: 48_000},
      canonicalTextVersion: 'canonical-v1',
    }),
  ).toBe(frozenStableJson)
})

test('the strategy id is fts- plus the first 16 hex characters of the sha256 of the stable JSON', () => {
  const expectedId = `fts-${createHash('sha256').update(frozenStableJson).digest('hex').slice(0, 16)}`

  expect(getFullTextStrategyId(frozenInputs)).toBe(expectedId)
  expect(getFullTextStrategyId(frozenInputs)).toBe('fts-185e42d99033451b')
  expect(getFullTextStrategyId(frozenInputs)).toMatch(/^fts-[0-9a-f]{16}$/)
})

test('every input changes the id', () => {
  const changedInputs: FullTextStrategyInputs[] = [
    {...frozenInputs, canonicalTextVersion: 'canonical-v2'},
    {...frozenInputs, chunkPolicy: {maxPromptTokens: 96_000, mode: 'chunked'}},
    {...frozenInputs, chunkPolicy: {maxPromptTokens: 48_000, mode: 'single_only'}},
    {...frozenInputs, converterKind: 'docling'},
    {...frozenInputs, converterOptionsHash: 'b'.repeat(64)},
    {...frozenInputs, converterVersion: '4.0.13'},
    {...frozenInputs, figureMode: 'native_images'},
    {...frozenInputs, imageTransportVersion: 'image-transport-v1'},
    {...frozenInputs, promptLayoutVersion: 'layout-v2'},
    {...frozenInputs, tokenizerId: 'cl100k_base'},
  ]
  const ids = changedInputs.map(getFullTextStrategyId)

  expect(new Set([getFullTextStrategyId(frozenInputs), ...ids]).size).toBe(changedInputs.length + 1)
})

test('the label names converter, figure mode and chunk policy', () => {
  expect(getFullTextStrategyLabel(frozenInputs)).toBe('mineru 4.0.12 / none / chunked 48k')
  expect(
    getFullTextStrategyLabel({
      ...frozenInputs,
      chunkPolicy: {maxPromptTokens: 24_000, mode: 'single_only'},
      converterKind: 'docling',
      converterVersion: 'docling=2.140.0 docling-core=2.48.0 docling-serve=1.37.0',
      figureMode: 'native_images',
    }),
  ).toBe('docling 1.37.0 / native images / single 24k')
  expect(getFullTextStrategy(frozenInputs)).toEqual({
    id: 'fts-185e42d99033451b',
    inputs: frozenInputs,
    label: 'mineru 4.0.12 / none / chunked 48k',
  })
})

test('chunk policies parse only from the fixed list', () => {
  expect(getFullTextChunkPolicy({maxPromptTokens: 24_000, mode: 'single_only'})).toEqual({
    maxPromptTokens: 24_000,
    mode: 'single_only',
  })
  expect(getFullTextChunkPolicy('{"maxPromptTokens":96000,"mode":"chunked"}')).toEqual({
    maxPromptTokens: 96_000,
    mode: 'chunked',
  })
  expect(getFullTextChunkPolicy({maxPromptTokens: 32_768, mode: 'chunked'})).toBeNull()
  expect(getFullTextChunkPolicy({maxPromptTokens: 48_000, mode: 'compact'})).toBeNull()
  expect(getFullTextChunkPolicy(null)).toBeNull()
})

test('legacy flags map to the legacy or none strategy and NULL means none', () => {
  expect(getLegacyFullTextStrategyId({useFulltext: true, useFulltextNoImages: false})).toBe('fts-legacy-v0')
  expect(getLegacyFullTextStrategyId({useFulltext: false, useFulltextNoImages: true})).toBe('fts-legacy-v0')
  expect(getLegacyFullTextStrategyId({useFulltext: false, useFulltextNoImages: false})).toBe('fts-none')
  expect(getEffectiveFullTextStrategyId(null)).toBe('fts-none')
  expect(getEffectiveFullTextStrategyId('fts-185e42d99033451b')).toBe('fts-185e42d99033451b')
  expect(getProjectFullTextStrategyIdSql('p')).toBe("COALESCE(p.full_text_strategy_id, 'fts-none')")
})

test('display labels cover the reserved ids and fall back to the stored label, then the id', () => {
  expect(getFullTextStrategyDisplayLabel('fts-none', null)).toBe('no full text')
  expect(getFullTextStrategyDisplayLabel('fts-legacy-v0', null)).toBe('legacy full text (before strategy tracking)')
  expect(getFullTextStrategyDisplayLabel('fts-185e42d99033451b', 'mineru 4.0.12 / none / chunked 48k')).toBe(
    'mineru 4.0.12 / none / chunked 48k',
  )
  expect(getFullTextStrategyDisplayLabel('fts-185e42d99033451b', null)).toBe('fts-185e42d99033451b')
})

test('input differences list the changed fields in key order', () => {
  expect(getFullTextStrategyInputDifferences(frozenInputs, frozenInputs)).toEqual([])
  expect(
    getFullTextStrategyInputDifferences(frozenInputs, {
      ...frozenInputs,
      chunkPolicy: {maxPromptTokens: 48_000, mode: 'single_only'},
      converterVersion: '4.0.13',
    }),
  ).toEqual(['chunkPolicy', 'converterVersion'])
})
