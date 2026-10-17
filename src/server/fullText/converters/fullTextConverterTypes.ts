export type FullTextConverterKind = 'docling' | 'mineru'

export type FullTextBoundingBox = [number, number, number, number]

export type FullTextLayoutBlock = {bbox: FullTextBoundingBox | null; page: number; text: string; type: string}

export type FullTextFigure = {
  bbox: FullTextBoundingBox | null
  caption: string | null
  imagePath: string
  index: number
  page: number | null
}

export type FullTextConversionResult = {
  converterKind: FullTextConverterKind
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
