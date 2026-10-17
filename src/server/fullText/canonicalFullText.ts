import {createHash} from 'node:crypto'

import {renderCanonicalUnits} from './canonicalFullText/canonicalFullTextRender.ts'
import {getSectionedCanonicalUnits} from './canonicalFullText/canonicalFullTextSections.ts'
import {type CanonicalDropReason, getCanonicalUnits} from './canonicalFullText/canonicalFullTextUnits.ts'
import {ConversionError} from './converters/conversionError.ts'
import {
  type FullTextConversionResult,
  type FullTextConverterKind,
  type FullTextLayoutBlock,
} from './converters/fullTextConverterTypes.ts'

export const CANONICAL_TEXT_VERSION = 'canonical-v1'

export const fullTextFigureModes = ['none', 'descriptions', 'native_images'] as const

export type FullTextFigureMode = (typeof fullTextFigureModes)[number]

export type CanonicalFullTextAsset = {caption: string | null; description?: string | null; index: number}

export type CanonicalFullTextInput = {
  assets: CanonicalFullTextAsset[]
  converterKind: FullTextConverterKind
  figureMode: FullTextFigureMode
  layout: FullTextLayoutBlock[]
}

export type CanonicalFullTextStats = {
  characters: number
  codeBlocks: number
  droppedBlocks: Partial<Record<CanonicalDropReason, number>>
  equations: number
  figures: number
  headings: number
  listItems: number
  missingDescriptions: number
  paragraphs: number
  tables: number
  unknownBlockTypes: string[]
}

export type CanonicalFullText = {
  figureMode: FullTextFigureMode
  hash: string
  stats: CanonicalFullTextStats
  text: string
  version: typeof CANONICAL_TEXT_VERSION
}

const canonicalError = (message: string): ConversionError => {
  return new ConversionError(`Canonical full text: ${message}`, undefined, true)
}

export const isFullTextFigureMode = (value: unknown): value is FullTextFigureMode => {
  return fullTextFigureModes.includes(value as FullTextFigureMode)
}

const getAssetByIndex = (assets: CanonicalFullTextAsset[]): Map<number, CanonicalFullTextAsset> => {
  const assetByIndex = new Map(
    assets.map((asset): [number, CanonicalFullTextAsset] => {
      return [asset.index, asset]
    }),
  )

  if (assetByIndex.size !== assets.length) {
    throw canonicalError('full_text_assets contains duplicate figure indexes')
  }

  return assetByIndex
}

const assertFigureReferences = (layout: FullTextLayoutBlock[], assetByIndex: Map<number, unknown>): void => {
  const figureIndexes = layout.flatMap((block) => {
    return block.figureIndex === undefined ? [] : [block.figureIndex]
  })
  const missingAsset = figureIndexes.find((figureIndex) => {
    return !assetByIndex.has(figureIndex)
  })
  const unplacedAsset = [...assetByIndex.keys()].find((figureIndex) => {
    return !figureIndexes.includes(figureIndex)
  })

  if (new Set(figureIndexes).size !== figureIndexes.length) {
    throw canonicalError('layout places the same figure more than once')
  }

  if (missingAsset !== undefined) {
    throw canonicalError(`layout places figure ${missingAsset} but full_text_assets has no entry with that index`)
  }

  if (unplacedAsset !== undefined) {
    throw canonicalError(`full_text_assets figure ${unplacedAsset} has no layout block`)
  }
}

const getDropCounts = (drops: CanonicalDropReason[]): Partial<Record<CanonicalDropReason, number>> => {
  return Object.fromEntries(
    [...new Set(drops)].sort().map((reason) => {
      return [
        reason,
        drops.filter((drop) => {
          return drop === reason
        }).length,
      ]
    }),
  )
}

const countUnits = (units: {kind: string}[], kind: string): number => {
  return units.filter((unit) => {
    return unit.kind === kind
  }).length
}

export const buildCanonicalFullText = ({
  assets,
  converterKind,
  figureMode,
  layout,
}: CanonicalFullTextInput): CanonicalFullText => {
  if (!isFullTextFigureMode(figureMode)) {
    throw canonicalError(`unknown figure mode ${String(figureMode)}`)
  }

  const assetByIndex = getAssetByIndex(assets)

  assertFigureReferences(layout, assetByIndex)

  const classified = getCanonicalUnits({converterKind, layout})
  const captionedFigureIndices = new Set(
    assets
      .filter((asset) => {
        return (asset.caption ?? '').trim() !== ''
      })
      .map((asset) => {
        return asset.index
      }),
  )
  const sectioned = getSectionedCanonicalUnits({captionedFigureIndices, sequence: classified})
  const rendered = renderCanonicalUnits({assetByIndex, figureMode, units: sectioned.units})

  if (rendered.text === '') {
    throw canonicalError('no body text is left after the strip rules')
  }

  return {
    figureMode,
    hash: createHash('sha256').update(rendered.text, 'utf8').digest('hex'),
    stats: {
      characters: rendered.text.length,
      codeBlocks: countUnits(sectioned.units, 'code'),
      droppedBlocks: getDropCounts(sectioned.drops),
      equations: countUnits(sectioned.units, 'equation'),
      figures: countUnits(sectioned.units, 'figure'),
      headings: countUnits(sectioned.units, 'heading'),
      listItems: countUnits(sectioned.units, 'list_item'),
      missingDescriptions: rendered.missingDescriptions,
      paragraphs: countUnits(sectioned.units, 'paragraph'),
      tables: countUnits(sectioned.units, 'table'),
      unknownBlockTypes: classified.unknownTypes,
    },
    text: rendered.text,
    version: CANONICAL_TEXT_VERSION,
  }
}

export const buildCanonicalFullTextFromConversion = ({
  figureMode,
  result,
}: {
  figureMode: FullTextFigureMode
  result: FullTextConversionResult
}): CanonicalFullText => {
  return buildCanonicalFullText({
    assets: result.figures,
    converterKind: result.converterKind,
    figureMode,
    layout: result.layout,
  })
}
