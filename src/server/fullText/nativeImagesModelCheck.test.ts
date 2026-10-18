import {expect, test} from 'bun:test'

import {
  getModelImageInputForModelId,
  getNativeImagesModelError,
  getNativeImagesModelErrorForModelId,
  getNativeImagesModelErrorMessage,
  type NativeImagesModelCandidate,
} from './nativeImagesModelCheck.ts'

const getCandidate = (overrides: Partial<NativeImagesModelCandidate>): NativeImagesModelCandidate => {
  return {label: 'Model', metadataJson: null, providerKind: 'codex', remoteModelId: 'gpt-5.5', ...overrides}
}

test('native images need a model whose resolved capabilities accept images on an image-capable transport', () => {
  const candidates = [
    getCandidate({label: 'GPT-5.5'}),
    getCandidate({label: 'Claude Sonnet 5.5', providerKind: 'claude-code', remoteModelId: 'claude-sonnet-5-5'}),
    getCandidate({label: 'Spark', remoteModelId: 'gpt-5.3-codex-spark'}),
    getCandidate({label: 'Local', providerKind: 'llamacpp', remoteModelId: 'qwen2.5-1.5b'}),
    getCandidate({label: 'Docling', providerKind: 'docling', remoteModelId: 'standard'}),
    getCandidate({label: 'GPT-5.5 text only', metadataJson: {capabilityOverrides: {supportsImageInput: false}}}),
  ]

  expect(
    candidates.map((model) => {
      return getNativeImagesModelError({figureMode: 'native_images', model})
    }),
  ).toEqual([
    null,
    null,
    getNativeImagesModelErrorMessage('Spark'),
    getNativeImagesModelErrorMessage('Local'),
    getNativeImagesModelErrorMessage('Docling'),
    getNativeImagesModelErrorMessage('GPT-5.5 text only'),
  ])
  expect(getNativeImagesModelErrorMessage('Spark')).toBe(
    'Model Spark cannot receive images. Choose Text only (figures reduced to their captions), or another model.',
  )
})

test('text only and an unset figure mode never check the model', () => {
  const textOnly = getCandidate({label: 'Spark', remoteModelId: 'gpt-5.3-codex-spark'})

  expect(
    (['none', null] as const).map((figureMode) => {
      return getNativeImagesModelError({figureMode, model: textOnly})
    }),
  ).toEqual([null, null])
})

test('the model-id lookup reads the stored model and refuses an unknown id by name', async () => {
  const statements: string[] = []
  const rows: Record<string, NativeImagesModelCandidate> = {
    'model-codex': getCandidate({label: 'GPT-5.5', metadataJson: '{"reasoningEffort":"high"}'}),
    'model-spark': getCandidate({label: 'Spark', remoteModelId: 'gpt-5.3-codex-spark'}),
  }
  const runner = {
    queryJson: async <T>(statement: string): Promise<T[]> => {
      statements.push(statement)
      const row = Object.entries(rows).find(([id]) => {
        return statement.includes(`'${id}'`)
      })?.[1]

      return (row ? [row] : []) as T[]
    },
  }
  const errors = await Promise.all(
    ['model-codex', 'model-spark', 'model-gone'].map((modelId) => {
      return getNativeImagesModelErrorForModelId({figureMode: 'native_images', modelId, runner})
    }),
  )

  expect(errors).toEqual([
    null,
    getNativeImagesModelErrorMessage('Spark'),
    getNativeImagesModelErrorMessage('model-gone'),
  ])
  expect(await getNativeImagesModelErrorForModelId({figureMode: 'none', modelId: 'model-spark', runner})).toBeNull()
  expect(statements).toHaveLength(3)
  expect(
    await Promise.all(
      ['model-codex', 'model-spark', 'model-gone'].map((modelId) => {
        return getModelImageInputForModelId({modelId, runner})
      }),
    ),
  ).toEqual([
    {acceptsImages: true, label: 'GPT-5.5'},
    {acceptsImages: false, label: 'Spark'},
    {acceptsImages: false, label: 'model-gone'},
  ])
})
