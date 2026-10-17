import {expect, test} from 'bun:test'

import {
  assertProviderModelAcceptsPromptImages,
  getProviderImageDataUrl,
  getProviderImageMimeType,
  getProviderPromptParts,
  getProviderTextOnlyPrompt,
  providerImageInputUnsupportedCode,
  providerModelImageInputUnsupportedCode,
  providerTransportSupportsImageInput,
} from './providerImageInput.ts'
import {requireProviderRegistryEntry} from './providerRegistry.ts'
import {
  type ProviderConnectionRecord,
  ProviderInvocationError,
  type ProviderModelRecord,
  type ProviderTransportFamily,
} from './providerTypes.ts'

const imagePrompt = {images: [{bytes: new Uint8Array([1, 2, 3]), mimeType: 'image/jpeg' as const}], text: 'Describe.'}

const getRejection = async (operation: () => Promise<unknown>): Promise<unknown> => {
  return operation().then(
    () => {
      return null
    },
    (error: unknown) => {
      return error
    },
  )
}

test('lists exactly the transports that can send image input', () => {
  const families: ProviderTransportFamily[] = [
    'anthropic-messages',
    'claude-code-cli',
    'codex-app',
    'docling-convert',
    'gemini-generate-content',
    'mineru-convert',
    'ollama-native-discovery',
    'openai-chat',
    'openai-responses',
  ]

  expect(families.filter(providerTransportSupportsImageInput)).toEqual([
    'anthropic-messages',
    'claude-code-cli',
    'codex-app',
    'gemini-generate-content',
    'ollama-native-discovery',
    'openai-chat',
    'openai-responses',
  ])
})

test('text-only transports accept strings and reject image prompts with a typed error', () => {
  expect(getProviderTextOnlyPrompt({prompt: 'Hello', transportFamily: 'docling-convert'})).toBe('Hello')

  const error = ((): unknown => {
    try {
      return getProviderTextOnlyPrompt({prompt: imagePrompt, transportFamily: 'mineru-convert'})
    } catch (caught) {
      return caught
    }
  })()

  expect(error).toBeInstanceOf(ProviderInvocationError)
  expect(error instanceof ProviderInvocationError ? error.code : null).toBe(providerImageInputUnsupportedCode)
})

test('prompt parts, data URLs and mime types', () => {
  expect(getProviderPromptParts('Hello')).toEqual({images: [], text: 'Hello'})
  expect(getProviderPromptParts(imagePrompt)).toBe(imagePrompt)
  expect(getProviderImageDataUrl({bytes: new Uint8Array([1, 2, 3]), mimeType: 'image/jpeg'})).toBe(
    'data:image/jpeg;base64,AQID',
  )
  expect(getProviderImageMimeType('assets/full-text-assets/a/fig-1.jpg')).toBe('image/jpeg')
  expect(getProviderImageMimeType('assets/full-text-assets/a/fig-1.JPEG')).toBe('image/jpeg')
  expect(getProviderImageMimeType('assets/full-text-assets/a/fig-2.png')).toBe('image/png')
  expect(getProviderImageMimeType('assets/full-text-assets/a/fig-3.webp')).toBeNull()
  expect(getProviderImageMimeType('assets/full-text-assets/a/fig-4')).toBeNull()
})

test('Codex and Claude Code adapters refuse image prompts for models that cannot receive images before any CLI call', async () => {
  const request = {
    maxCompletionTokens: 64,
    outputSchema: {type: 'object'},
    prompt: imagePrompt,
    systemPrompt: 'System',
    temperature: 0,
  }
  const textOnlyModels = {
    'claude-code': {
      metadataJson: {capabilityOverrides: {supportsImageInput: false, updatedAt: '2026-10-17T00:00:00.000Z'}},
      modelName: 'claude-haiku-5-5',
      name: 'claude-haiku-5-5',
      remoteModelId: 'claude-haiku-5-5',
    },
    codex: {
      metadataJson: null,
      modelName: 'gpt-5.3-codex-spark',
      name: 'gpt-5.3-codex-spark',
      remoteModelId: 'gpt-5.3-codex-spark',
    },
  }
  const runtimeCredentials = {apiKey: null, baseURL: null, headers: {}, secretRef: null}
  const errors = await Promise.all(
    (['codex', 'claude-code'] as const).map((providerKind) => {
      return getRejection(() => {
        return requireProviderRegistryEntry(providerKind).invoke({
          connection: {providerKind} as unknown as ProviderConnectionRecord,
          model: {
            ...textOnlyModels[providerKind],
            id: `${providerKind}-model`,
            variant: null,
            version: null,
          } as unknown as ProviderModelRecord,
          request,
          runtimeCredentials,
        })
      })
    }),
  )

  expect(
    errors.map((error) => {
      return error instanceof ProviderInvocationError ? [error.code, error.providerKind] : String(error)
    }),
  ).toEqual([
    [providerModelImageInputUnsupportedCode, 'codex'],
    [providerModelImageInputUnsupportedCode, 'claude-code'],
  ])
})

test('the model image guard passes text prompts, image-free prompts and image-capable models', () => {
  const textOnlyModel = {
    id: 'spark',
    metadataJson: null,
    modelName: 'gpt-5.3-codex-spark',
    name: 'gpt-5.3-codex-spark',
    remoteModelId: 'gpt-5.3-codex-spark',
  } as unknown as ProviderModelRecord
  const imageModel = {...textOnlyModel, id: 'gpt', remoteModelId: 'gpt-5.5'} as ProviderModelRecord
  const check = (model: ProviderModelRecord, prompt: typeof imagePrompt | string) => {
    try {
      assertProviderModelAcceptsPromptImages({model, prompt, providerKind: 'codex'})
      return null
    } catch (error) {
      return error instanceof ProviderInvocationError ? error.message : String(error)
    }
  }

  expect([
    check(textOnlyModel, 'Hello'),
    check(textOnlyModel, {images: [], text: 'Hello'}),
    check(imageModel, imagePrompt),
    check(textOnlyModel, imagePrompt),
  ]).toEqual([null, null, null, 'Model gpt-5.3-codex-spark cannot receive images'])
})
