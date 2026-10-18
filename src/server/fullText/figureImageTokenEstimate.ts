import {getFigureImageEncodingError} from './figureImageEncodingError.ts'

/**
 * img-tok-v1, the full-text strategy input `imageTokenEstimateVersion` of every native-images strategy.
 *
 * Per image: OpenAI's documented patch tokenization for gpt-6-astra at `detail: 'high'` (the detail the Codex
 * transport sends): cover the image with 32 px patches; above 2,500 patches shrink it to the budget (65,535 px
 * maximum side); bill 1.2 tokens per patch, rounded up; then add 6 framing tokens. The framing term is the residual
 * measured on Codex GPT-6-Astra in the 2026-10-18 live run (5.0–6.0 tokens per image over 16 articles and 3 parts).
 *
 * The estimate is the same for every provider, so a strategy plans the same parts for every model. It is computed from
 * the pixel dimensions alone; flattening keeps them, so the raw crop and the flattened PNG give the same estimate.
 */
export const IMAGE_TOKEN_ESTIMATE_VERSION = 'img-tok-v1'

export type FigureImageDimensions = {height: number; width: number}

export type FigureImageTokenEstimateInput = {bytes: Uint8Array; figureIndex: number}

const patchSize = 32
const patchBudget = 2_500
const maxSidePixels = 65_535
const framingTokensPerImage = 6

const pngSignature = [137, 80, 78, 71, 13, 10, 26, 10]
const pngIhdrWidthOffset = 16
const pngIhdrHeightOffset = 20
const pngIhdrEnd = 24

const jpegStartOfImage = [0xff, 0xd8]
const jpegMarkerPrefix = 0xff
const jpegStandaloneMarkers = new Set([0x01, 0xd0, 0xd1, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8])
const jpegNonFrameMarkersInSofRange = new Set([0xc4, 0xc8, 0xcc])

const hasSignature = (bytes: Uint8Array, signature: number[]): boolean => {
  return (
    bytes.length >= signature.length
    && signature.every((value, index) => {
      return bytes[index] === value
    })
  )
}

const readUint16 = (bytes: Uint8Array, offset: number): number => {
  return ((bytes[offset] ?? 0) << 8) | (bytes[offset + 1] ?? 0)
}

const readUint32 = (bytes: Uint8Array, offset: number): number => {
  return readUint16(bytes, offset) * 65_536 + readUint16(bytes, offset + 2)
}

const isJpegFrameMarker = (marker: number): boolean => {
  return marker >= 0xc0 && marker <= 0xcf && !jpegNonFrameMarkersInSofRange.has(marker)
}

const getJpegDimensions = (bytes: Uint8Array): FigureImageDimensions | null => {
  const scan = (offset: number): FigureImageDimensions | null => {
    if (offset + 4 > bytes.length || bytes[offset] !== jpegMarkerPrefix) {
      return null
    }

    const marker = bytes[offset + 1] ?? 0

    if (marker === jpegMarkerPrefix) {
      return scan(offset + 1)
    }

    if (jpegStandaloneMarkers.has(marker)) {
      return scan(offset + 2)
    }

    if (isJpegFrameMarker(marker)) {
      return offset + 9 > bytes.length
        ? null
        : {height: readUint16(bytes, offset + 5), width: readUint16(bytes, offset + 7)}
    }

    return marker === 0xd9 || marker === 0xda ? null : scan(offset + 2 + readUint16(bytes, offset + 2))
  }

  return scan(jpegStartOfImage.length)
}

const getPngDimensions = (bytes: Uint8Array): FigureImageDimensions | null => {
  return bytes.length >= pngIhdrEnd
    ? {height: readUint32(bytes, pngIhdrHeightOffset), width: readUint32(bytes, pngIhdrWidthOffset)}
    : null
}

export const getFigureImageDimensions = (bytes: Uint8Array): FigureImageDimensions => {
  const dimensions = hasSignature(bytes, pngSignature)
    ? getPngDimensions(bytes)
    : hasSignature(bytes, jpegStartOfImage)
      ? getJpegDimensions(bytes)
      : null

  if (!dimensions || dimensions.width <= 0 || dimensions.height <= 0) {
    throw getFigureImageEncodingError('Figure image has no readable PNG or JPEG pixel dimensions')
  }

  return dimensions
}

const getPatchCount = ({height, width}: FigureImageDimensions): number => {
  return Math.ceil(width / patchSize) * Math.ceil(height / patchSize)
}

const fitMaxSide = (dimensions: FigureImageDimensions): FigureImageDimensions => {
  const scale = Math.min(1, maxSidePixels / Math.max(dimensions.width, dimensions.height))

  return scale === 1
    ? dimensions
    : {height: Math.floor(dimensions.height * scale), width: Math.floor(dimensions.width * scale)}
}

const shrinkToPatchBudget = ({height, width}: FigureImageDimensions): FigureImageDimensions => {
  const shrink = Math.sqrt((patchSize * patchSize * patchBudget) / (width * height))
  const scaledWidthPatches = (width * shrink) / patchSize
  const scaledHeightPatches = (height * shrink) / patchSize
  const adjustedShrink =
    shrink
    * Math.min(
      Math.floor(scaledWidthPatches) / scaledWidthPatches,
      Math.floor(scaledHeightPatches) / scaledHeightPatches,
    )

  return {height: Math.floor(height * adjustedShrink), width: Math.floor(width * adjustedShrink)}
}

export const getFigureImagePatchCount = (dimensions: FigureImageDimensions): number => {
  const fitted = fitMaxSide(dimensions)

  return getPatchCount(fitted) > patchBudget ? getPatchCount(shrinkToPatchBudget(fitted)) : getPatchCount(fitted)
}

const estimators: Record<string, (dimensions: FigureImageDimensions) => number> = {
  [IMAGE_TOKEN_ESTIMATE_VERSION]: (dimensions) => {
    // 1.2 tokens per patch as 6/5 in integer arithmetic, so 5 patches bill exactly 6 tokens.
    return Math.ceil((getFigureImagePatchCount(dimensions) * 6) / 5) + framingTokensPerImage
  },
}

export const isKnownImageTokenEstimateVersion = (version: string | null | undefined): version is string => {
  return typeof version === 'string' && Object.hasOwn(estimators, version)
}

export const getFigureImageTokenEstimate = ({
  dimensions,
  version,
}: {
  dimensions: FigureImageDimensions
  version: string
}): number => {
  const estimate = isKnownImageTokenEstimateVersion(version) ? estimators[version] : undefined

  if (!estimate) {
    throw new Error(
      `Image token estimate ${version} is not part of this build (known: ${IMAGE_TOKEN_ESTIMATE_VERSION})`,
    )
  }

  return estimate(dimensions)
}

export const getFigureImageTokenEstimates = ({
  images,
  version,
}: {
  images: FigureImageTokenEstimateInput[]
  version: string
}): Map<number, number> => {
  return new Map(
    images.map((image) => {
      return [
        image.figureIndex,
        getFigureImageTokenEstimate({dimensions: getFigureImageDimensions(image.bytes), version}),
      ] as const
    }),
  )
}
