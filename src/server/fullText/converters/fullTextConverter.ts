import {readFile} from 'node:fs/promises'
import {basename} from 'node:path'

import {resolveRuntimeFilePath} from '../../utils/runtimeWritablePath.ts'
import {ConversionError} from './conversionError.ts'
import {getConverterOptionsHash} from './converterOptionsHash.ts'
import {doclingConverter} from './doclingConverter.ts'
import {writeFullTextAssetFiles} from './fullTextAssetFiles.ts'
import {
  FULL_TEXT_LAYOUT_VERSION,
  type FullTextConversionResult,
  type FullTextConverter,
} from './fullTextConverterTypes.ts'
import {mineruConverter} from './mineruConverter.ts'

export type FullTextConversionRuntimeConfig = {
  baseURL: string
  modelId: string
  modelName: string
  providerKind: string
}

export const getFullTextConverter = (providerKind: string): FullTextConverter => {
  const converter = providerKind === 'mineru' ? mineruConverter : providerKind === 'docling' ? doclingConverter : null

  if (!converter) {
    throw new ConversionError(`Provider kind ${providerKind} is not a PDF conversion provider`)
  }

  return converter
}

const readPdfBytes = async (absolutePath: string): Promise<Uint8Array<ArrayBuffer>> => {
  const buffer = await readFile(absolutePath).catch(() => {
    throw new ConversionError(`File not found: ${absolutePath}`, undefined, true)
  })

  return new Uint8Array(buffer)
}

export const convertArticlePdf = async ({
  articleId,
  cwd,
  pdfPath,
  runtimeConfig,
  timeoutMs,
}: {
  articleId: string
  cwd?: string
  pdfPath: string
  runtimeConfig: FullTextConversionRuntimeConfig
  timeoutMs: number
}): Promise<FullTextConversionResult> => {
  const converter = getFullTextConverter(runtimeConfig.providerKind)
  const absolutePath = resolveRuntimeFilePath({cwd, pathValue: pdfPath})
  const pdfBytes = await readPdfBytes(absolutePath)
  const parsed = await converter.convert({
    baseURL: runtimeConfig.baseURL,
    fileName: basename(absolutePath),
    pdfBytes,
    timeoutMs,
  })

  if (parsed.markdown.trim() === '') {
    throw new ConversionError(`${converter.kind} returned no Markdown content for ${absolutePath}`)
  }

  const assets = await writeFullTextAssetFiles({
    articleId,
    cwd,
    figures: parsed.figures,
    layout: parsed.layout,
    markdown: parsed.markdown,
  })

  return {
    converterKind: converter.kind,
    converterMarkdownPath: assets.converterMarkdownPath,
    converterVersion: parsed.converterVersion,
    figures: assets.figures,
    html: parsed.html,
    layout: parsed.layout,
    layoutPath: assets.layoutPath,
    markdown: parsed.markdown,
    optionsHash: getConverterOptionsHash(converter.options),
  }
}

export const getFullTextConversionMetadata = ({
  result,
  runtimeConfig,
}: {
  result: FullTextConversionResult
  runtimeConfig: FullTextConversionRuntimeConfig
}) => {
  return {
    baseURL: runtimeConfig.baseURL,
    converterKind: result.converterKind,
    converterMarkdownPath: result.converterMarkdownPath,
    converterVersion: result.converterVersion,
    layoutPath: result.layoutPath,
    layoutVersion: FULL_TEXT_LAYOUT_VERSION,
    modelId: runtimeConfig.modelId,
    modelName: runtimeConfig.modelName,
    optionsHash: result.optionsHash,
    providerKind: runtimeConfig.providerKind,
  }
}

const getFailureConverterIdentity = (providerKind: string) => {
  const converter = providerKind === 'mineru' ? mineruConverter : providerKind === 'docling' ? doclingConverter : null

  return converter ? {converterKind: converter.kind, optionsHash: getConverterOptionsHash(converter.options)} : {}
}

export const getFullTextConversionFailureMetadata = (runtimeConfig: FullTextConversionRuntimeConfig) => {
  return {
    baseURL: runtimeConfig.baseURL,
    ...getFailureConverterIdentity(runtimeConfig.providerKind),
    modelId: runtimeConfig.modelId,
    modelName: runtimeConfig.modelName,
    providerKind: runtimeConfig.providerKind,
  }
}

export const isPermanentConversionFailure = (error: unknown): boolean => {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase()

  return (
    (error instanceof ConversionError && error.isPermanent)
    || message.includes('encrypted')
    || message.includes('password')
    || message.includes('invalid pdf')
    || message.includes('file not found')
  )
}
