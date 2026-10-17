export type FullTextConverterKind = 'docling' | 'mineru'

export const FULL_TEXT_LAYOUT_VERSION = 'layout-v2'

export type FullTextBoundingBox = [number, number, number, number]

export type FullTextLayoutPart = {depth?: number; text: string; type: string}

export type FullTextLayoutBlock = {
  bbox: FullTextBoundingBox | null
  container?: 'picture' | 'table'
  continuesPrevious?: true
  figureIndex?: number
  level?: number
  listMarker?: string
  page: number
  parts?: FullTextLayoutPart[]
  text: string
  type: string
}

export type FullTextLayoutFile = {blocks: FullTextLayoutBlock[]; version: typeof FULL_TEXT_LAYOUT_VERSION}

export type FullTextFigure = {
  bbox: FullTextBoundingBox | null
  caption: string | null
  imagePath: string
  index: number
  page: number | null
}

export type FullTextConversionResult = {
  converterKind: FullTextConverterKind
  converterMarkdownPath: string
  converterVersion: string
  figures: FullTextFigure[]
  html: string | null
  layout: FullTextLayoutBlock[]
  layoutPath: string
  markdown: string
  optionsHash: string
}

export type FullTextParsedFigureImage = {bytes: Uint8Array; extension: string}

export type FullTextParsedFigure = Omit<FullTextFigure, 'imagePath'> & {image: FullTextParsedFigureImage}

export type FullTextParsedConversion = {
  converterVersion: string
  figures: FullTextParsedFigure[]
  html: string | null
  layout: FullTextLayoutBlock[]
  markdown: string
}

export type FullTextConverterRequest = {
  baseURL: string
  fileName: string
  pdfBytes: Uint8Array<ArrayBuffer>
  timeoutMs: number
}

export type FullTextConverter = {
  convert: (request: FullTextConverterRequest) => Promise<FullTextParsedConversion>
  kind: FullTextConverterKind
  options: Record<string, unknown>
}
