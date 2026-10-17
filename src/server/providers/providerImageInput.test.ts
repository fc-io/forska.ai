import {expect, test} from 'bun:test'

import {
  getProviderImageDataUrl,
  getProviderImageMimeType,
  getProviderPromptParts,
  getProviderTextOnlyPrompt,
  providerImageInputUnsupportedCode,
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
    'gemini-generate-content',
    'ollama-native-discovery',
    'openai-chat',
    'openai-responses',
  ])
})

test('text-only transports accept strings and reject image prompts with a typed error', () => {
  expect(getProviderTextOnlyPrompt({prompt: 'Hello', transportFamily: 'codex-app'})).toBe('Hello')

  const error = ((): unknown => {
    try {
      return getProviderTextOnlyPrompt({prompt: imagePrompt, transportFamily: 'codex-app'})
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

test('Codex and Claude Code adapters refuse image prompts before invoking their CLI', async () => {
  const request = {
    maxCompletionTokens: 64,
    outputSchema: {type: 'object'},
    prompt: imagePrompt,
    systemPrompt: 'System',
    temperature: 0,
  }
  const model = {modelName: 'gpt-5.5', name: 'gpt-5.5', remoteModelId: 'gpt-5.5', variant: null, version: null}
  const runtimeCredentials = {apiKey: null, baseURL: null, headers: {}, secretRef: null}
  const errors = await Promise.all(
    (['codex', 'claude-code'] as const).map((providerKind) => {
      return getRejection(() => {
        return requireProviderRegistryEntry(providerKind).invoke({
          connection: {providerKind} as unknown as ProviderConnectionRecord,
          model: model as unknown as ProviderModelRecord,
          request,
          runtimeCredentials,
        })
      })
    }),
  )

  expect(
    errors.map((error) => {
      return error instanceof ProviderInvocationError ? error.code : String(error)
    }),
  ).toEqual([providerImageInputUnsupportedCode, providerImageInputUnsupportedCode])
})
