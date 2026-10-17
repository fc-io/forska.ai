import {expect, test} from 'bun:test'

import {IMAGE_TRANSPORT_VERSION} from './fullTextStrategy.ts'
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
  figureDescription: null,
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
    figureDescriptionModelId: null,
    figureDescriptionPromptVersion: null,
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

test('descriptions need a figure-description model and native images need image transports', () => {
  const chunkPolicy = {maxPromptTokens: 96_000, mode: 'chunked'} as const

  expect(resolveFullTextStrategy({chunkPolicy, figureMode: 'descriptions'}, environment).errors).toEqual([
    fullTextStrategyErrorMessages.figureDescriptionModelMissing,
  ])
  expect(resolveFullTextStrategy({chunkPolicy, figureMode: 'native_images'}, environment).errors).toEqual([
    fullTextStrategyErrorMessages.imageTransportMissing,
  ])
  expect(
    resolveFullTextStrategy(
      {chunkPolicy, figureMode: 'descriptions'},
      {...environment, figureDescription: {modelId: 'model-vlm', promptVersion: 'fig-desc-v1'}},
    ).strategy?.inputs,
  ).toMatchObject({figureDescriptionModelId: 'model-vlm', figureDescriptionPromptVersion: 'fig-desc-v1'})
  expect(
    resolveFullTextStrategy(
      {chunkPolicy, figureMode: 'none'},
      {...environment, figureDescription: {modelId: 'model-vlm', promptVersion: 'fig-desc-v1'}},
    ).strategy?.inputs,
  ).toMatchObject({figureDescriptionModelId: null, figureDescriptionPromptVersion: null})
})

test('native images resolve with the shipped image transport version, which only enters native-image strategies', () => {
  const chunkPolicy = {maxPromptTokens: 48_000, mode: 'single_only'} as const
  const imageEnvironment = {...environment, imageTransportVersion: IMAGE_TRANSPORT_VERSION}
  const nativeImages = resolveFullTextStrategy({chunkPolicy, figureMode: 'native_images'}, imageEnvironment)

  expect(IMAGE_TRANSPORT_VERSION).toBe('img-v1')
  expect(nativeImages.errors).toEqual([])
  expect(nativeImages.strategy?.label).toBe('mineru 4.0.12 / native images / single 48k')
  expect(nativeImages.strategy?.inputs).toMatchObject({
    figureDescriptionModelId: null,
    figureMode: 'native_images',
    imageTransportVersion: 'img-v1',
  })
  expect(resolveFullTextStrategy({chunkPolicy, figureMode: 'none'}, imageEnvironment)).toEqual(
    resolveFullTextStrategy({chunkPolicy, figureMode: 'none'}, environment),
  )
})
