import {readFileSync} from 'node:fs'

import {expect, test} from 'bun:test'

import {figureImageEncodingInvalidCode, flattenFigureImage} from '../fullText/figureImageEncoding.ts'
import {
  getProviderImageBase64,
  getProviderImageBase64Length,
  getProviderTransportImages,
  PROVIDER_IMAGE_MAX_BASE64_BYTES,
  providerImageTooLargeCode,
} from './providerImageInput.ts'
import {type ProviderInvokeImage, type ProviderMultipartPrompt} from './providerTypes.ts'
import {getAnthropicUserContent} from './transports/anthropicMessagesTransport.ts'
import {getClaudeCodeStreamJsonUserMessage} from './transports/claudeCodeCliTransport.ts'
import {getCodexAppTurnImageUrls} from './transports/codexAppTransport.ts'
import {getGeminiGenerateContentRequestBody} from './transports/geminiGenerateContentTransport.ts'
import {getOpenAIChatCompletionRequest} from './transports/openaiChatTransport.ts'
import {getOpenAIResponsesRequest} from './transports/openaiResponsesTransport.ts'

const transparentPng: ProviderInvokeImage = {
  bytes: new Uint8Array(
    readFileSync(new URL('../fullText/fixtures/figureImages/transparent-3x2.png', import.meta.url)),
  ),
  mimeType: 'image/png',
}
const jpeg: ProviderInvokeImage = {bytes: Uint8Array.of(0xff, 0xd8, 0xff, 0xe0), mimeType: 'image/jpeg'}

const getJpegOfBase64Length = (base64Length: number): ProviderInvokeImage => {
  return {
    bytes: Uint8Array.from({length: (base64Length / 4) * 3}, (_, index) => {
      return [0xff, 0xd8, 0xff][index] ?? 0
    }),
    mimeType: 'image/jpeg',
  }
}

const getThrownCode = (run: () => unknown): unknown => {
  try {
    run()
    return null
  } catch (error) {
    return (error as {code?: unknown}).code
  }
}

const getBase64FromDataUrl = (url: string) => {
  return url.slice(url.indexOf(',') + 1)
}

const getImagePayloadsByTransport = (prompt: ProviderMultipartPrompt): Record<string, string[]> => {
  const chatContent = getOpenAIChatCompletionRequest({
    maxCompletionTokens: 64,
    modelName: 'vision',
    outputSchema: {type: 'object'},
    prompt,
    systemPrompt: 'System',
    temperature: 0,
  }).messages[1]?.content
  const responsesInput = getOpenAIResponsesRequest({
    maxCompletionTokens: 64,
    modelName: 'vision',
    outputSchema: {type: 'object'},
    prompt,
    systemPrompt: 'System',
    temperature: 0,
  }).input[1] as {content: Array<{image_url?: string}>}
  const anthropicContent = getAnthropicUserContent(prompt) as Array<{source?: {data: string}}>
  const geminiParts = getGeminiGenerateContentRequestBody({prompt, systemPrompt: 'System', temperature: 0}).contents[0]
    ?.parts as Array<{inlineData?: {data: string}}>
  const claudeContent = (
    JSON.parse(getClaudeCodeStreamJsonUserMessage(prompt)) as {message: {content: Array<{source?: {data: string}}>}}
  ).message.content

  return {
    anthropic: anthropicContent.flatMap((part) => {
      return part.source ? [part.source.data] : []
    }),
    claudeCode: claudeContent.flatMap((part) => {
      return part.source ? [part.source.data] : []
    }),
    codex: getCodexAppTurnImageUrls(prompt).map(getBase64FromDataUrl),
    gemini: geminiParts.flatMap((part) => {
      return part.inlineData ? [part.inlineData.data] : []
    }),
    openaiChat: (chatContent as Array<{image_url?: {url: string}}>).flatMap((part) => {
      return part.image_url ? [getBase64FromDataUrl(part.image_url.url)] : []
    }),
    openaiResponses: responsesInput.content.flatMap((part) => {
      return part.image_url ? [getBase64FromDataUrl(part.image_url)] : []
    }),
  }
}

test('every image transport sends the same flattened bytes in prompt order', () => {
  const expected = [getProviderImageBase64(flattenFigureImage(transparentPng)), getProviderImageBase64(jpeg)]
  const payloads = getImagePayloadsByTransport({images: [transparentPng, jpeg], text: 'Article\n\n[figure:1]'})

  expect(expected[0]).not.toBe(getProviderImageBase64(transparentPng))
  expect(payloads).toEqual({
    anthropic: expected,
    claudeCode: expected,
    codex: expected,
    gemini: expected,
    openaiChat: expected,
    openaiResponses: expected,
  })
})

test('an image exactly at the 5 MB base64 limit passes and one 3 bytes larger is refused with a typed error', () => {
  const atLimit = getJpegOfBase64Length(PROVIDER_IMAGE_MAX_BASE64_BYTES)
  const overLimit = getJpegOfBase64Length(PROVIDER_IMAGE_MAX_BASE64_BYTES + 4)

  expect(getProviderImageBase64Length(atLimit)).toBe(PROVIDER_IMAGE_MAX_BASE64_BYTES)
  expect(getProviderTransportImages([atLimit])).toEqual([atLimit])
  expect(getProviderImageBase64Length(overLimit)).toBe(PROVIDER_IMAGE_MAX_BASE64_BYTES + 4)
  expect(
    getThrownCode(() => {
      return getProviderTransportImages([jpeg, overLimit])
    }),
  ).toBe(providerImageTooLargeCode)
  expect(() => {
    return getProviderTransportImages([jpeg, overLimit])
  }).toThrow(`Image 2 is 5242884 bytes base64-encoded after flattening; the per-image limit is 5242880 bytes (5 MB)`)
})

test('every image transport refuses an oversize image instead of sending or downscaling it', () => {
  const prompt = {images: [getJpegOfBase64Length(PROVIDER_IMAGE_MAX_BASE64_BYTES + 4)], text: 'Article'}
  const builders: Array<() => unknown> = [
    () => {
      return getOpenAIChatCompletionRequest({
        maxCompletionTokens: 64,
        modelName: 'vision',
        outputSchema: {type: 'object'},
        prompt,
        systemPrompt: 'System',
        temperature: 0,
      })
    },
    () => {
      return getOpenAIResponsesRequest({
        maxCompletionTokens: 64,
        modelName: 'vision',
        outputSchema: {type: 'object'},
        prompt,
        systemPrompt: 'System',
        temperature: 0,
      })
    },
    () => {
      return getAnthropicUserContent(prompt)
    },
    () => {
      return getGeminiGenerateContentRequestBody({prompt, systemPrompt: 'System', temperature: 0})
    },
    () => {
      return getCodexAppTurnImageUrls(prompt)
    },
    () => {
      return getClaudeCodeStreamJsonUserMessage(prompt)
    },
  ]

  expect(builders.map(getThrownCode)).toEqual(
    Array.from({length: 6}, () => {
      return providerImageTooLargeCode
    }),
  )
})

test('HTTP transports refuse a PNG-labelled image that is not a PNG', () => {
  const prompt = {images: [{bytes: Uint8Array.of(4, 5), mimeType: 'image/png' as const}], text: 'Article'}

  expect(
    getThrownCode(() => {
      return getAnthropicUserContent(prompt)
    }),
  ).toBe(figureImageEncodingInvalidCode)
})
