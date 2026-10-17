import {normalizeInlineText} from '../../server/fullText/canonicalFullText/canonicalFullTextUnits.ts'
import {
  type FigureDescriptionAssetState,
  type FigureDescriptionTarget,
  getFigureDescriptionAssetState,
  isFigureDescriptionAsset,
} from '../../server/fullText/figureDescriptionAssets.ts'
import type {FullTextFigureMode} from '../../utils/fullTextStrategyOptions.ts'

export type FullTextJudgingFigureAsset = {
  description: string
  descriptionState: FigureDescriptionAssetState | null
  index: number
}

export type RenderedFullTextForJudging = {
  failedDescriptionFigureIndexes: number[]
  missingDescriptionFigureIndexes: number[]
  text: string
}

export class FullTextFigureMarkerError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'FullTextFigureMarkerError'
  }
}

const figureMarkerLinePattern = /^\[figure:(\d+)\]$/

const figureDescriptionStates: readonly FigureDescriptionAssetState[] = ['described', 'failed', 'needed']

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

const getDescriptionState = (
  value: Record<string, unknown>,
  target: FigureDescriptionTarget | null,
): FigureDescriptionAssetState | null => {
  return target === null
    ? null
    : isFigureDescriptionAsset(value)
      ? getFigureDescriptionAssetState(value, target)
      : 'failed'
}

const toFigureAsset = (value: unknown, target: FigureDescriptionTarget | null): FullTextJudgingFigureAsset => {
  if (!isRecord(value) || !Number.isInteger(value.index)) {
    throw new FullTextFigureMarkerError('full_text_assets entry has no integer figure index')
  }

  const descriptionState = getDescriptionState(value, target)

  return {
    description:
      descriptionState === 'described' && typeof value.description === 'string'
        ? normalizeInlineText(value.description)
        : '',
    descriptionState,
    index: value.index as number,
  }
}

export const getFullTextJudgingFigureAssets = (
  value: unknown,
  target: FigureDescriptionTarget | null,
): FullTextJudgingFigureAsset[] => {
  return getAssetList(value).map((entry) => {
    return toFigureAsset(entry, target)
  })
}

const isFigureDescriptionState = (value: unknown): value is FigureDescriptionAssetState => {
  return typeof value === 'string' && (figureDescriptionStates as readonly string[]).includes(value)
}

const isStoredJudgingFigureAsset = (value: unknown): value is FullTextJudgingFigureAsset => {
  return (
    isRecord(value)
    && Number.isInteger(value.index)
    && typeof value.description === 'string'
    && (value.descriptionState === null || isFigureDescriptionState(value.descriptionState))
  )
}

export const getStoredFullTextJudgingFigureAssets = (value: unknown): FullTextJudgingFigureAsset[] | null => {
  return Array.isArray(value) && value.every(isStoredJudgingFigureAsset)
    ? value.map((asset) => {
        return {description: asset.description, descriptionState: asset.descriptionState, index: asset.index}
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

const renderMarkerLine = ({
  assetByIndex,
  figureMode,
  line,
}: {
  assetByIndex: Map<number, FullTextJudgingFigureAsset>
  figureMode: FullTextFigureMode
  line: string
}): string[] => {
  const markerIndex = getFigureMarkerIndex(line)
  const description = markerIndex === null ? '' : (assetByIndex.get(markerIndex)?.description ?? '')

  return markerIndex === null || figureMode === 'native_images'
    ? [line]
    : figureMode === 'none'
      ? []
      : [description === '' ? line : `Description: ${description}`]
}

const getMarkerIndexesInState = ({
  assetByIndex,
  figureMode,
  markerIndexes,
  state,
}: {
  assetByIndex: Map<number, FullTextJudgingFigureAsset>
  figureMode: FullTextFigureMode
  markerIndexes: number[]
  state: FigureDescriptionAssetState
}): number[] => {
  return figureMode === 'descriptions'
    ? markerIndexes.filter((index) => {
        const asset = assetByIndex.get(index)

        return state === 'needed'
          ? asset?.descriptionState === 'needed'
              || (asset?.descriptionState === 'described' && asset.description === '')
          : asset?.descriptionState === state
      })
    : []
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

  const assetByIndex = new Map(
    assets.map((asset): [number, FullTextJudgingFigureAsset] => {
      return [asset.index, asset]
    }),
  )

  return {
    failedDescriptionFigureIndexes: getMarkerIndexesInState({assetByIndex, figureMode, markerIndexes, state: 'failed'}),
    missingDescriptionFigureIndexes: getMarkerIndexesInState({
      assetByIndex,
      figureMode,
      markerIndexes,
      state: 'needed',
    }),
    text: lines
      .flatMap((line) => {
        return renderMarkerLine({assetByIndex, figureMode, line})
      })
      .join('\n'),
  }
}
