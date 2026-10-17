import {expect, test} from 'bun:test'

import {getOpenAIResponsesRequest} from './openaiResponsesTransport.ts'

test('maps image prompts to input_text followed by input_image data URIs', () => {
  const request = getOpenAIResponsesRequest({
    maxCompletionTokens: 128,
    modelName: 'gpt-5.5',
    outputSchema: {type: 'object'},
    prompt: {images: [{bytes: new Uint8Array([4, 5]), mimeType: 'image/png'}], text: 'Describe.'},
    systemPrompt: 'System',
    temperature: 0,
  })

  expect(request.input).toEqual([
    {content: 'System', role: 'system'},
    {
      content: [
        {text: 'Describe.', type: 'input_text'},
        {image_url: 'data:image/png;base64,BAU=', type: 'input_image'},
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
