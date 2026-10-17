import {readFile} from 'node:fs/promises'

import {getProviderImageMimeType} from '../providers/providerImageInput.ts'
import {invokeStoredProviderModel} from '../providers/providerInvocationService.ts'
import {type ProviderInvocationResult, type ProviderUsageSnapshot} from '../providers/providerTypes.ts'
import {resolveRuntimeFilePath} from '../utils/runtimeWritablePath.ts'

export const FIGURE_DESCRIPTION_PROMPT_VERSION = 'fig-desc-v1'

export const FIGURE_DESCRIPTION_MAX_WORDS = 120

export const figureDescriptionInputInvalidCode = 'figure_description_input_invalid'

export const figureDescriptionMaxCompletionTokens = 1024

export const figureDescriptionTemperature = 0.7

export const figureDescriptionTimeoutMs = 300_000

export const figureDescriptionSystemPrompt = [
  'You describe one figure from a scientific article for a reader who cannot see it.',
  'Describe only what the figure shows:',
  '- the type of figure (for example bar chart, line graph, forest plot, Kaplan-Meier curve, flow diagram, scatter plot, photograph, schematic);',
  '- the axes with their labels and units, and the groups, arms, conditions or panels that are compared;',
  '- the key numbers and the direction of each effect or difference that the figure displays;',
  '- text written inside the figure (labels, legends, annotations, numbers at risk).',
  'Do not interpret beyond the figure: no conclusions, no clinical meaning, no assumptions about the study, and nothing that is not visible in the image.',
  `Write at most ${FIGURE_DESCRIPTION_MAX_WORDS} words of plain text in one paragraph, without Markdown, lists or headings.`,
  'Return JSON of the form {"description": "..."}.',
].join('\n')

export const figureDescriptionOutputSchema = {
  additionalProperties: false,
  properties: {description: {type: 'string'}},
  required: ['description'],
  type: 'object',
}

export type FigureDescriptionModel = {modelId: string}

export type FigureDescriptionResult = {description: string; usage: ProviderUsageSnapshot}

export const getFigureDescriptionUserText = (caption: string | null): string => {
  const normalizedCaption = String(caption ?? '').trim()

  return [
    normalizedCaption === '' ? 'The figure has no caption.' : `Caption: ${normalizedCaption}`,
    'Describe the attached figure.',
  ].join('\n\n')
}

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const parseFigureDescriptionJson = (text: string): unknown => {
  try {
    return JSON.parse(text.trim()) as unknown
  } catch {
    throw new Error(`Figure description response is not JSON: ${text.trim().slice(0, 200)}`)
  }
}

export const normalizeFigureDescription = (value: string): string => {
  return value.normalize('NFC').replace(/\s+/g, ' ').trim()
}

export const getFigureDescriptionFromResponse = (result: Pick<ProviderInvocationResult, 'text'>): string => {
  const parsed = parseFigureDescriptionJson(result.text)
  const description =
    isRecord(parsed) && typeof parsed.description === 'string' ? normalizeFigureDescription(parsed.description) : ''

  if (description === '') {
    throw new Error(`Figure description response has no description: ${result.text.trim().slice(0, 200)}`)
  }

  return description
}

const getFigureImageMimeType = (imagePath: string) => {
  const mimeType = getProviderImageMimeType(imagePath)

  if (!mimeType) {
    throw Object.assign(new Error(`Figure ${imagePath} is not a JPEG or PNG file`), {
      code: figureDescriptionInputInvalidCode,
    })
  }

  return mimeType
}

export const describeFigure = async ({
  caption,
  cwd,
  imagePath,
  model,
  signal,
}: {
  caption: string | null
  cwd?: string
  imagePath: string
  model: FigureDescriptionModel
  signal?: AbortSignal
}): Promise<FigureDescriptionResult> => {
  const mimeType = getFigureImageMimeType(imagePath)
  const bytes = new Uint8Array(await readFile(resolveRuntimeFilePath({cwd, pathValue: imagePath})))
  const result = await invokeStoredProviderModel({
    maxCompletionTokens: figureDescriptionMaxCompletionTokens,
    modelId: model.modelId,
    outputSchema: figureDescriptionOutputSchema,
    prompt: {images: [{bytes, mimeType}], text: getFigureDescriptionUserText(caption)},
    signal: signal ?? AbortSignal.timeout(figureDescriptionTimeoutMs),
    systemPrompt: figureDescriptionSystemPrompt,
    temperature: figureDescriptionTemperature,
  })

  return {description: getFigureDescriptionFromResponse(result), usage: result.usage}
}
