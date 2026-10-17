import {extname} from 'node:path'

import {
  ProviderInvocationError,
  type ProviderInvokeImage,
  type ProviderInvokePrompt,
  type ProviderMultipartPrompt,
  type ProviderTransportFamily,
} from './providerTypes.ts'

export const providerImageInputUnsupportedCode = 'provider_image_input_unsupported'

const imageInputTransportFamilies: ReadonlySet<ProviderTransportFamily> = new Set([
  'anthropic-messages',
  'gemini-generate-content',
  'ollama-native-discovery',
  'openai-chat',
  'openai-responses',
])

const imageMimeTypesByExtension: Record<string, ProviderInvokeImage['mimeType']> = {
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
}

export const providerTransportSupportsImageInput = (transportFamily: ProviderTransportFamily): boolean => {
  return imageInputTransportFamilies.has(transportFamily)
}

export const isProviderMultipartPrompt = (prompt: ProviderInvokePrompt): prompt is ProviderMultipartPrompt => {
  return typeof prompt !== 'string'
}

export const getProviderImageInputUnsupportedError = (transportFamily: ProviderTransportFamily) => {
  return new ProviderInvocationError(`Transport ${transportFamily} cannot send image input`, {
    code: providerImageInputUnsupportedCode,
    diagnostics: {transportFamily},
  })
}

export const getProviderTextOnlyPrompt = ({
  prompt,
  transportFamily,
}: {
  prompt: ProviderInvokePrompt
  transportFamily: ProviderTransportFamily
}): string => {
  if (isProviderMultipartPrompt(prompt)) {
    throw getProviderImageInputUnsupportedError(transportFamily)
  }

  return prompt
}

export const getProviderPromptParts = (prompt: ProviderInvokePrompt): ProviderMultipartPrompt => {
  return isProviderMultipartPrompt(prompt) ? prompt : {images: [], text: prompt}
}

export const getProviderImageBase64 = (image: ProviderInvokeImage): string => {
  return Buffer.from(image.bytes).toString('base64')
}

export const getProviderImageDataUrl = (image: ProviderInvokeImage): string => {
  return `data:${image.mimeType};base64,${getProviderImageBase64(image)}`
}

export const getProviderImageMimeType = (filePath: string): ProviderInvokeImage['mimeType'] | null => {
  return imageMimeTypesByExtension[extname(filePath).toLowerCase()] ?? null
}
