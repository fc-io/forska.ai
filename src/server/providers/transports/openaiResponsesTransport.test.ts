import {readFileSync} from 'node:fs'

import {expect, test} from 'bun:test'

import {flattenFigureImage} from '../../fullText/figureImageEncoding.ts'
import {getProviderImageBase64} from '../providerImageInput.ts'
import {getOpenAIResponsesRequest} from './openaiResponsesTransport.ts'

const transparentPng = {
  bytes: new Uint8Array(
    readFileSync(new URL('../../fullText/fixtures/figureImages/transparent-3x2.png', import.meta.url)),
  ),
  mimeType: 'image/png' as const,
}
const flattenedPngBase64 = getProviderImageBase64(flattenFigureImage(transparentPng))

test('maps image prompts to input_text followed by input_image data URIs', () => {
  const request = getOpenAIResponsesRequest({
    maxCompletionTokens: 128,
    modelName: 'gpt-5.5',
    outputSchema: {type: 'object'},
    prompt: {images: [transparentPng], text: 'Describe.'},
    systemPrompt: 'System',
    temperature: 0,
  })

  expect(request.input).toEqual([
    {content: 'System', role: 'system'},
    {
      content: [
        {text: 'Describe.', type: 'input_text'},
        {image_url: `data:image/png;base64,${flattenedPngBase64}`, type: 'input_image'},
      ],
      role: 'user',
    },
  ])
  expect(request.max_output_tokens).toBe(128)
})

test('keeps text-only prompts as a plain string input', () => {
  const request = getOpenAIResponsesRequest({
    modelName: 'gpt-5.5',
    outputSchema: {type: 'object'},
    prompt: 'Prompt',
    systemPrompt: 'System',
    temperature: 0.2,
  })

  expect(request.input[1]).toEqual({content: 'Prompt', role: 'user'})
  expect('max_output_tokens' in request).toBe(false)
})
