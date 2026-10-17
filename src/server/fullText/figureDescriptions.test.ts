import {createHash} from 'node:crypto'
import {mkdtemp, rm, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

import {afterAll, afterEach, beforeAll, expect, mock, test} from 'bun:test'

import type {StoredProviderInvocationInput} from '../providers/providerInvocationService.ts'

type FigureDescriptionsModule = typeof import('./figureDescriptions.ts')

const providerInvocationServiceModulePath = new URL('../providers/providerInvocationService.ts', import.meta.url).href
const figureDescriptionsModulePath = new URL('./figureDescriptions.ts', import.meta.url).href
const invokeStoredProviderModel = mock(async (_input: StoredProviderInvocationInput) => {
  return {
    text: '{"description":"  Bar chart of\\n mortality by arm.  "}',
    usage: {completionTokens: 12, promptTokens: 300, totalTokens: 312},
  }
})
const directory = {path: ''}

const loadFigureDescriptions = (): Promise<FigureDescriptionsModule> => {
  void mock.module(providerInvocationServiceModulePath, () => {
    return {invokeStoredProviderModel}
  })

  return import(`${figureDescriptionsModulePath}?test=${Date.now()}-${Math.random()}`)
}

beforeAll(async () => {
  directory.path = await mkdtemp(join(tmpdir(), 'figure-descriptions-'))
  await writeFile(join(directory.path, 'fig-1.jpg'), new Uint8Array([255, 216, 255, 224]))
  await writeFile(join(directory.path, 'fig-2.gif'), new Uint8Array([71, 73, 70]))
})

afterAll(async () => {
  await rm(directory.path, {force: true, recursive: true})
})

afterEach(() => {
  mock.restore()
  invokeStoredProviderModel.mockClear()
})

test('prompt fig-desc-v1 is frozen: changing its text requires a new prompt version', async () => {
  const module = await loadFigureDescriptions()
  const promptHash = createHash('sha256')
    .update(
      JSON.stringify({
        maxCompletionTokens: module.figureDescriptionMaxCompletionTokens,
        noCaption: module.getFigureDescriptionUserText(null),
        schema: module.figureDescriptionOutputSchema,
        system: module.figureDescriptionSystemPrompt,
        temperature: module.figureDescriptionTemperature,
        withCaption: module.getFigureDescriptionUserText('Figure 2. Survival by arm.'),
      }),
    )
    .digest('hex')

  expect(module.FIGURE_DESCRIPTION_PROMPT_VERSION).toBe('fig-desc-v1')
  expect(promptHash).toBe('6f65dde888c49d32f3240972236d77604144c4fa9252b508ac396bdb2b922074')
})

test('describeFigure sends the crop bytes and caption as one image prompt and normalises the description', async () => {
  const module = await loadFigureDescriptions()
  const result = await module.describeFigure({
    caption: ' Figure 2. Survival by arm. ',
    imagePath: join(directory.path, 'fig-1.jpg'),
    model: {modelId: 'model-vlm'},
  })
  const input = invokeStoredProviderModel.mock.calls[0]?.[0]

  expect(result).toEqual({
    description: 'Bar chart of mortality by arm.',
    usage: {completionTokens: 12, promptTokens: 300, totalTokens: 312},
  })
  expect(input).toMatchObject({
    maxCompletionTokens: module.figureDescriptionMaxCompletionTokens,
    modelId: 'model-vlm',
    outputSchema: module.figureDescriptionOutputSchema,
    systemPrompt: module.figureDescriptionSystemPrompt,
    temperature: 0.7,
  })
  expect(input?.prompt).toEqual({
    images: [{bytes: new Uint8Array([255, 216, 255, 224]), mimeType: 'image/jpeg'}],
    text: 'Caption: Figure 2. Survival by arm.\n\nDescribe the attached figure.',
  })
})

test('describeFigure refuses non-JPEG/PNG crops with a permanent input error and no model call', async () => {
  const module = await loadFigureDescriptions()
  const error = await module
    .describeFigure({caption: null, imagePath: join(directory.path, 'fig-2.gif'), model: {modelId: 'model-vlm'}})
    .then(
      () => {
        return null
      },
      (caught: unknown) => {
        return caught as {code?: string}
      },
    )

  expect(error?.code).toBe(module.figureDescriptionInputInvalidCode)
  expect(invokeStoredProviderModel).not.toHaveBeenCalled()
})

test('responses must be JSON with a non-empty description', async () => {
  const module = await loadFigureDescriptions()

  expect(module.getFigureDescriptionFromResponse({text: '{"description":"Flow diagram."}'})).toBe('Flow diagram.')
  expect(() => {
    return module.getFigureDescriptionFromResponse({text: 'A flow diagram.'})
  }).toThrow('Figure description response is not JSON')
  expect(() => {
    return module.getFigureDescriptionFromResponse({text: '{"description":"   "}'})
  }).toThrow('Figure description response has no description')
  expect(() => {
    return module.getFigureDescriptionFromResponse({text: '{"text":"x"}'})
  }).toThrow('Figure description response has no description')
})
