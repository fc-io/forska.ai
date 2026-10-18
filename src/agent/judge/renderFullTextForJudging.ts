import type {FullTextFigureMode} from '../../utils/fullTextStrategyOptions.ts'

export type FullTextJudgingFigureAsset = {imagePath: string | null; index: number}

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

const getAssetList = (value: unknown): unknown[] => {
  const parsed = getParsedAssetsValue(value)

  if (!Array.isArray(parsed)) {
    throw new FullTextFigureMarkerError('full_text_assets is not a figure list')
  }

  return parsed
}

const toFigureAsset = (value: unknown): FullTextJudgingFigureAsset => {
  if (!isRecord(value) || !Number.isInteger(value.index)) {
    throw new FullTextFigureMarkerError('full_text_assets entry has no integer figure index')
  }

  return {imagePath: typeof value.imagePath === 'string' ? value.imagePath : null, index: value.index as number}
}

export const getFullTextJudgingFigureAssets = (value: unknown): FullTextJudgingFigureAsset[] => {
  return getAssetList(value).map(toFigureAsset)
}

const isStoredJudgingFigureAsset = (value: unknown): value is FullTextJudgingFigureAsset => {
  return (
    isRecord(value)
    && Number.isInteger(value.index)
    && (value.imagePath === null || typeof value.imagePath === 'string')
  )
}

export const getStoredFullTextJudgingFigureAssets = (value: unknown): FullTextJudgingFigureAsset[] | null => {
  return Array.isArray(value) && value.every(isStoredJudgingFigureAsset)
    ? value.map((asset) => {
        return {imagePath: asset.imagePath, index: asset.index}
      })
    : null
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

const renderMarkerLine = (figureMode: FullTextFigureMode, line: string): string[] => {
  return figureMode === 'none' && getFigureMarkerIndex(line) !== null ? [] : [line]
}

export const renderFullTextForJudging = ({
  assets,
  figureMode,
  text,
}: {
  assets: FullTextJudgingFigureAsset[]
  figureMode: FullTextFigureMode
  text: string
}): string => {
  const lines = text.split('\n')

  assertMarkersReferenceAssets({assets, markerIndexes: getMarkerIndexes(lines)})

  return lines
    .flatMap((line) => {
      return renderMarkerLine(figureMode, line)
    })
    .join('\n')
}
