import {afterEach, expect, mock, test} from 'bun:test'

import {invokeGeminiGenerateContentModel} from './geminiGenerateContentTransport.ts'

const originalFetch = globalThis.fetch
const fetchMock = mock(async (_input: RequestInfo | URL, _init?: RequestInit) => {
  return new Response(
    JSON.stringify({
      candidates: [{content: {parts: [{text: '{"description":"A forest plot."}'}]}}],
      usageMetadata: {candidatesTokenCount: 5, promptTokenCount: 20, totalTokenCount: 25},
    }),
    {headers: {'content-type': 'application/json'}, status: 200},
  )
})

const getRequestBody = (): unknown => {
  const body = fetchMock.mock.calls[0]?.[1]?.body

  return typeof body === 'string' ? (JSON.parse(body) as unknown) : null
}

afterEach(() => {
  fetchMock.mockClear()
  globalThis.fetch = originalFetch
})

test('sends image prompts as a text part followed by inlineData parts', async () => {
  globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch

  const result = await invokeGeminiGenerateContentModel({
    apiKey: 'test-key',
    baseURL: 'https://generativelanguage.googleapis.com/v1beta',
    maxCompletionTokens: 64,
    modelName: 'gemini-2.5-flash',
    prompt: {images: [{bytes: new Uint8Array([255, 216, 255]), mimeType: 'image/jpeg'}], text: 'Describe.'},
    systemPrompt: 'System',
    temperature: 0,
  })

  expect(result.text).toBe('{"description":"A forest plot."}')
  expect(String(fetchMock.mock.calls[0]?.[0] as string)).toContain('/models/gemini-2.5-flash:generateContent')
  expect(getRequestBody()).toEqual({
    contents: [{parts: [{text: 'Describe.'}, {inlineData: {data: '/9j/', mimeType: 'image/jpeg'}}], role: 'user'}],
    generationConfig: {maxOutputTokens: 64, temperature: 0},
    systemInstruction: {parts: [{text: 'System'}]},
  })
})

test('keeps text-only prompts as one text part', async () => {
  globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch

  await invokeGeminiGenerateContentModel({
    apiKey: 'test-key',
    baseURL: 'https://generativelanguage.googleapis.com/v1beta',
    modelName: 'gemini-2.5-flash',
    prompt: 'Hello',
    systemPrompt: 'System',
    temperature: 0.2,
  })

  expect(getRequestBody()).toMatchObject({contents: [{parts: [{text: 'Hello'}], role: 'user'}]})
})
