export const MAX_FIGURE_DESCRIPTION_ATTEMPTS = 3

export type FigureDescriptionTarget = {modelId: string; promptVersion: string}

export type FigureDescriptionAsset = Record<string, unknown> & {
  caption: string | null
  description?: string | null
  descriptionAttemptModelId?: string | null
  descriptionAttemptPromptVersion?: string | null
  descriptionAttempts?: number | null
  descriptionError?: string | null
  descriptionFailedAt?: string | null
  descriptionModelId?: string | null
  descriptionPromptVersion?: string | null
  describedAt?: string | null
  imagePath: string
  index: number
}

export type FigureDescriptionAssetState = 'described' | 'failed' | 'needed'

export type FigureDescriptionCounts = {described: number; failed: number; needed: number; total: number}

const figureDescriptionFailureFields = [
  'descriptionAttemptModelId',
  'descriptionAttemptPromptVersion',
  'descriptionAttempts',
  'descriptionError',
  'descriptionFailedAt',
] as const

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export const isFigureDescriptionAsset = (value: unknown): value is FigureDescriptionAsset => {
  return (
    isRecord(value)
    && Number.isInteger(value.index)
    && typeof value.imagePath === 'string'
    && (value.caption === null || typeof value.caption === 'string')
  )
}

const isDescribedForTarget = (asset: FigureDescriptionAsset, target: FigureDescriptionTarget): boolean => {
  return (
    typeof asset.description === 'string'
    && asset.description.trim() !== ''
    && asset.descriptionModelId === target.modelId
    && asset.descriptionPromptVersion === target.promptVersion
  )
}

const isAttemptForTarget = (asset: FigureDescriptionAsset, target: FigureDescriptionTarget): boolean => {
  return (
    asset.descriptionAttemptModelId === target.modelId && asset.descriptionAttemptPromptVersion === target.promptVersion
  )
}

const getTargetAttempts = (asset: FigureDescriptionAsset, target: FigureDescriptionTarget): number => {
  return isAttemptForTarget(asset, target) && typeof asset.descriptionAttempts === 'number'
    ? asset.descriptionAttempts
    : 0
}

export const getFigureDescriptionAssetState = (
  asset: FigureDescriptionAsset,
  target: FigureDescriptionTarget,
): FigureDescriptionAssetState => {
  return isDescribedForTarget(asset, target)
    ? 'described'
    : getTargetAttempts(asset, target) >= MAX_FIGURE_DESCRIPTION_ATTEMPTS
      ? 'failed'
      : 'needed'
}

export const getFigureDescriptionCounts = (
  assets: FigureDescriptionAsset[],
  target: FigureDescriptionTarget,
): FigureDescriptionCounts => {
  return assets.reduce(
    (counts, asset) => {
      const state = getFigureDescriptionAssetState(asset, target)

      return {...counts, [state]: counts[state] + 1}
    },
    {described: 0, failed: 0, needed: 0, total: assets.length},
  )
}

const getAssetWithoutFailureFields = (asset: FigureDescriptionAsset): FigureDescriptionAsset => {
  return Object.fromEntries(
    Object.entries(asset).filter(([key]) => {
      return !(figureDescriptionFailureFields as readonly string[]).includes(key)
    }),
  ) as FigureDescriptionAsset
}

export const getDescribedFigureAsset = ({
  asset,
  describedAt,
  description,
  target,
}: {
  asset: FigureDescriptionAsset
  describedAt: Date
  description: string
  target: FigureDescriptionTarget
}): FigureDescriptionAsset => {
  return {
    ...getAssetWithoutFailureFields(asset),
    describedAt: describedAt.toISOString(),
    description,
    descriptionModelId: target.modelId,
    descriptionPromptVersion: target.promptVersion,
  }
}

export const getFailedFigureAsset = ({
  asset,
  error,
  failedAt,
  permanent,
  target,
}: {
  asset: FigureDescriptionAsset
  error: string
  failedAt: Date
  permanent: boolean
  target: FigureDescriptionTarget
}): FigureDescriptionAsset => {
  const attempts = getTargetAttempts(asset, target) + 1

  return {
    ...asset,
    descriptionAttemptModelId: target.modelId,
    descriptionAttemptPromptVersion: target.promptVersion,
    descriptionAttempts: permanent ? Math.max(attempts, MAX_FIGURE_DESCRIPTION_ATTEMPTS) : attempts,
    descriptionError: error,
    descriptionFailedAt: failedAt.toISOString(),
  }
}

export const getAssetWithoutFigureDescription = (asset: FigureDescriptionAsset): FigureDescriptionAsset => {
  return Object.fromEntries(
    Object.entries(getAssetWithoutFailureFields(asset)).filter(([key]) => {
      return !['describedAt', 'description', 'descriptionModelId', 'descriptionPromptVersion'].includes(key)
    }),
  ) as FigureDescriptionAsset
}
