import {expect, test} from 'bun:test'

import type {FullTextJudgingInput} from '../../../../agent/judge/fullTextJudgingInput.ts'
import {getFullTextImageLogAttrs} from './processPromptWithLLM.ts'

const getFullTextJudging = (figureImages: FullTextJudgingInput['figureImages']): FullTextJudgingInput => {
  return {
    chunkPlan: null,
    figureImageTokens: null,
    figureImages,
    renderedText: 'text',
    strategy: {
      canonicalTextVersion: 'canonical-v1',
      chunkPolicy: {maxPromptTokens: 24_000, mode: 'single_only'},
      figureMode: 'native_images',
      id: 'fts-0000000000000001',
      imageTokenEstimateVersion: 'img-tok-v1',
    },
    textHash: 'hash',
  }
}

test('llm:calling carries one image count and one byte total for full-text prompts, nothing for others', () => {
  expect(
    getFullTextImageLogAttrs(
      getFullTextJudging([
        {bytes: new Uint8Array(300), figureIndex: 1, mimeType: 'image/png'},
        {bytes: new Uint8Array(45), figureIndex: 2, mimeType: 'image/jpeg'},
      ]),
    ),
  ).toEqual({imageBytes: 345, imageCount: 2})
  expect(getFullTextImageLogAttrs(getFullTextJudging([]))).toEqual({imageBytes: 0, imageCount: 0})
  expect(getFullTextImageLogAttrs(null)).toEqual({})
})
