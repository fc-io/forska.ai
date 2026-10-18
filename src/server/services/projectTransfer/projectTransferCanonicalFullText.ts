import {createHash} from 'node:crypto'

export const projectTransferCanonicalFullTextFields = [
  'fullTextCanonicalHash',
  'fullTextCanonicalVersion',
  'fullTextFigureModeBuilt',
] as const

export const projectTransferConversionMetadataAssetPathKeys = ['converterMarkdownPath', 'layoutPath'] as const

export type ProjectTransferCanonicalFullTextField = (typeof projectTransferCanonicalFullTextFields)[number]

export const getProjectTransferCanonicalFullTextHash = (text: string) => {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}
