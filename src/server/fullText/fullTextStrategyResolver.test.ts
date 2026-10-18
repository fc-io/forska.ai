import {expect, test} from 'bun:test'

import {IMAGE_TOKEN_ESTIMATE_VERSION} from './figureImageTokenEstimate.ts'
import {IMAGE_TRANSPORT_VERSION, isFullTextFigureMode} from './fullTextStrategy.ts'
import {
  type FullTextStrategyEnvironment,
  fullTextStrategyErrorMessages,
  resolveFullTextStrategy,
} from './fullTextStrategyResolver.ts'

const environment: FullTextStrategyEnvironment = {
  canonicalTextVersion: 'canonical-v1',
  conversionModel: {
    converterKind: 'mineru',
    converterOptionsHash: 'c'.repeat(64),
    converterVersion: '4.0.12',
    modelLabel: 'MinerU standard',
  },
  imageTokenEstimateVersion: null,
  imageTransportVersion: null,
}

test('a complete selection resolves to the strategy built from the environment and the shipped constants', () => {
  const resolution = resolveFullTextStrategy(
    {chunkPolicy: {maxPromptTokens: 48_000, mode: 'chunked'}, figureMode: 'none'},
    environment,
  )

  expect(resolution.errors).toEqual([])
  expect(resolution.strategy?.label).toBe('mineru 4.0.12 / none / chunked 48k')
  expect(resolution.strategy?.inputs).toEqual({
    canonicalTextVersion: 'canonical-v1',
    chunkPolicy: {maxPromptTokens: 48_000, mode: 'chunked'},
    converterKind: 'mineru',
    converterOptionsHash: 'c'.repeat(64),
    converterVersion: '4.0.12',
    figureMode: 'none',
    imageTransportVersion: null,
    promptLayoutVersion: 'layout-v2',
    tokenizerId: 'o200k_base',
  })
  expect(resolution.strategy?.id).toMatch(/^fts-[0-9a-f]{16}$/)
})

test('missing choices and missing installation inputs are listed, never defaulted', () => {
  expect(
    resolveFullTextStrategy(
      {chunkPolicy: null, figureMode: null},
      {...environment, canonicalTextVersion: null, conversionModel: null},
    ),
  ).toEqual({
    errors: [
      fullTextStrategyErrorMessages.conversionModelMissing,
      fullTextStrategyErrorMessages.canonicalTextVersionMissing,
      fullTextStrategyErrorMessages.figureModeMissing,
      fullTextStrategyErrorMessages.chunkPolicyMissing,
    ],
    strategy: null,
  })
})

test('a conversion model without a reported server version is an error naming the model', () => {
  const resolution = resolveFullTextStrategy(
    {chunkPolicy: {maxPromptTokens: 24_000, mode: 'single_only'}, figureMode: 'none'},
    {
      ...environment,
      conversionModel: {
        converterKind: 'mineru',
        converterOptionsHash: 'c'.repeat(64),
        converterVersion: null,
        modelLabel: 'MinerU standard',
      },
    },
  )

  expect(resolution.strategy).toBeNull()
  expect(resolution.errors).toHaveLength(1)
  expect(resolution.errors[0]).toContain('MinerU standard has not reported a server version')
})

test('native images need image transports and the inputs hold no figure-description fields', () => {
  const chunkPolicy = {maxPromptTokens: 96_000, mode: 'chunked'} as const
  const textOnly = resolveFullTextStrategy({chunkPolicy, figureMode: 'none'}, environment)

  expect(resolveFullTextStrategy({chunkPolicy, figureMode: 'native_images'}, environment).errors).toEqual([
    fullTextStrategyErrorMessages.imageTransportMissing,
    fullTextStrategyErrorMessages.imageTokenEstimateMissing,
  ])
  expect(
    resolveFullTextStrategy(
      {chunkPolicy, figureMode: 'native_images'},
      {...environment, imageTransportVersion: IMAGE_TRANSPORT_VERSION},
    ).errors,
  ).toEqual([fullTextStrategyErrorMessages.imageTokenEstimateMissing])
  expect(fullTextStrategyErrorMessages.imageTransportMissing).toContain('Choose Text only')
  expect(fullTextStrategyErrorMessages.figureModeMissing).toBe(
    'Full text needs a figure mode: choose Text only (figures reduced to their captions) or Include figures as images.',
  )
  expect(Object.keys(textOnly.strategy?.inputs ?? {}).sort()).toEqual([
    'canonicalTextVersion',
    'chunkPolicy',
    'converterKind',
    'converterOptionsHash',
    'converterVersion',
    'figureMode',
    'imageTransportVersion',
    'promptLayoutVersion',
    'tokenizerId',
  ])
})

test('the figure modes are none and native_images; a stored descriptions value is not a figure mode', () => {
  expect(isFullTextFigureMode('none')).toBe(true)
  expect(isFullTextFigureMode('native_images')).toBe(true)
  expect(isFullTextFigureMode('descriptions')).toBe(false)
})

test('native images resolve with the shipped image transport version, which only enters native-image strategies', () => {
  const chunkPolicy = {maxPromptTokens: 48_000, mode: 'single_only'} as const
  const imageEnvironment = {
    ...environment,
    imageTokenEstimateVersion: IMAGE_TOKEN_ESTIMATE_VERSION,
    imageTransportVersion: IMAGE_TRANSPORT_VERSION,
  }
  const nativeImages = resolveFullTextStrategy({chunkPolicy, figureMode: 'native_images'}, imageEnvironment)

  expect(IMAGE_TRANSPORT_VERSION).toBe('img-v1')
  expect(nativeImages.errors).toEqual([])
  expect(nativeImages.strategy?.label).toBe('mineru 4.0.12 / native images / single 48k')
  expect(nativeImages.strategy?.inputs).toMatchObject({
    figureMode: 'native_images',
    imageTokenEstimateVersion: 'img-tok-v1',
    imageTransportVersion: 'img-v1',
  })
  expect(resolveFullTextStrategy({chunkPolicy, figureMode: 'none'}, imageEnvironment)).toEqual(
    resolveFullTextStrategy({chunkPolicy, figureMode: 'none'}, environment),
  )
})
