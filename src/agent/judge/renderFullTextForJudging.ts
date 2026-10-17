import {normalizeInlineText} from '../../server/fullText/canonicalFullText/canonicalFullTextUnits.ts'
import type {FullTextFigureMode} from '../../utils/fullTextStrategyOptions.ts'

export type FullTextJudgingFigureAsset = {description: string; index: number}

export type RenderedFullTextForJudging = {missingDescriptionFigureIndexes: number[]; text: string}

export class FullTextFigureMarkerError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'FullTextFigureMarkerError'
  }
}

const figureMarkerLinePattern = /^\[figure:(\d+)\]$/

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const getParsedAssetsValue = (value: unknown): unknown => {
  return typeof value === 'string' ? JSON.parse(value) : (value ?? [])
}

const toFigureAsset = (value: unknown): FullTextJudgingFigureAsset => {
  if (!isRecord(value) || !Number.isInteger(value.index)) {
    throw new FullTextFigureMarkerError('full_text_assets entry has no integer figure index')
  }

  return {
    description: normalizeInlineText(typeof value.description === 'string' ? value.description : ''),
    index: value.index as number,
  }
}

export const getFullTextJudgingFigureAssets = (value: unknown): FullTextJudgingFigureAsset[] => {
  const parsed = getParsedAssetsValue(value)

  if (!Array.isArray(parsed)) {
    throw new FullTextFigureMarkerError('full_text_assets is not a figure list')
  }

  return parsed.map(toFigureAsset)
}

export const getMissingFigureDescriptionCount = (assets: unknown): number => {
  return getFullTextJudgingFigureAssets(assets).filter((asset) => {
    return asset.description === ''
  }).length
}

const getFigureMarkerIndex = (line: string): number | null => {
  const match = figureMarkerLinePattern.exec(line)

  return match ? Number(match[1]) : null
}

const getMarkerIndexes = (lines: string[]): number[] => {
  return lines.map(getFigureMarkerIndex).filter((index): index is number => {
    return index !== null
  })
}

const getSortedNumbers = (values: number[]): number[] => {
  return [...values].sort((left, right) => {
    return left - right
  })
}

const assertMarkersReferenceAssets = ({
  assets,
  markerIndexes,
}: {
  assets: FullTextJudgingFigureAsset[]
  markerIndexes: number[]
}): void => {
  const assetIndexes = new Set(
    assets.map((asset) => {
      return asset.index
    }),
  )
  const unknownIndexes = markerIndexes.filter((index) => {
    return !assetIndexes.has(index)
  })
  const repeatedIndexes = markerIndexes.filter((index, position) => {
    return markerIndexes.indexOf(index) !== position
  })

  if (unknownIndexes.length > 0 || repeatedIndexes.length > 0) {
    throw new FullTextFigureMarkerError(
      `stored full text figure markers [${getSortedNumbers(markerIndexes).join(', ')}] do not match full_text_assets [${getSortedNumbers([...assetIndexes]).join(', ')}]`,
    )
  }
}

const renderMarkerLine = ({
  descriptionByIndex,
  figureMode,
  line,
}: {
  descriptionByIndex: Map<number, string>
  figureMode: FullTextFigureMode
  line: string
}): string[] => {
  const markerIndex = getFigureMarkerIndex(line)
  const description = markerIndex === null ? '' : (descriptionByIndex.get(markerIndex) ?? '')

  return markerIndex === null || figureMode === 'native_images'
    ? [line]
    : figureMode === 'none'
      ? []
      : [description === '' ? line : `Description: ${description}`]
}

export const renderFullTextForJudging = ({
  assets,
  figureMode,
  text,
}: {
  assets: FullTextJudgingFigureAsset[]
  figureMode: FullTextFigureMode
  text: string
}): RenderedFullTextForJudging => {
  const lines = text.split('\n')
  const markerIndexes = getMarkerIndexes(lines)

  assertMarkersReferenceAssets({assets, markerIndexes})

  const descriptionByIndex = new Map(
    assets.map((asset): [number, string] => {
      return [asset.index, asset.description]
    }),
  )
  const missingDescriptionFigureIndexes =
    figureMode === 'descriptions'
      ? markerIndexes.filter((index) => {
          return (descriptionByIndex.get(index) ?? '') === ''
        })
      : []

  return {
    missingDescriptionFigureIndexes,
    text: lines
      .flatMap((line) => {
        return renderMarkerLine({descriptionByIndex, figureMode, line})
      })
      .join('\n'),
  }
}
