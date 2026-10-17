import {readFile} from 'node:fs/promises'

import {
  getProviderImageBase64Length,
  getProviderImageMimeType,
  isProviderImageTooLarge,
  PROVIDER_IMAGE_MAX_BASE64_BYTES,
} from '../providers/providerImageInput.ts'
import {type ProviderInvokeImage} from '../providers/providerTypes.ts'
import {resolveRuntimeFilePath} from '../utils/runtimeWritablePath.ts'
import {flattenFigureImage} from './figureImageEncoding.ts'

export const nativeFigureImageErrorCodes = {
  assetMissing: 'native_figure_asset_missing',
  duplicateMarker: 'native_figure_marker_duplicate',
  fileMissing: 'native_figure_image_missing',
  fileUnsupported: 'native_figure_image_unsupported',
  tooLarge: 'native_figure_image_too_large',
} as const

export type NativeFigureImageErrorCode = (typeof nativeFigureImageErrorCodes)[keyof typeof nativeFigureImageErrorCodes]

export type NativeFigureImageError = Error & {
  code: NativeFigureImageErrorCode
  figureIndex: number
  imagePath: string | null
}

export type NativeFigureImageAsset = {imagePath: string; index: number}

export type NativeFigureImageInput = ProviderInvokeImage & {figureIndex: number}

const nativeFigureMarkerPattern = /^\[figure:(\d+)\]$/gm

const nativeFigureImageErrorCodeValues = new Set<string>(Object.values(nativeFigureImageErrorCodes))

const getNativeFigureImageError = ({
  code,
  figureIndex,
  imagePath,
  message,
}: {
  code: NativeFigureImageErrorCode
  figureIndex: number
  imagePath: string | null
  message: string
}): NativeFigureImageError => {
  return Object.assign(new Error(message), {code, figureIndex, imagePath})
}

export const isNativeFigureImageError = (error: unknown): error is NativeFigureImageError => {
  return error instanceof Error && nativeFigureImageErrorCodeValues.has(String((error as {code?: unknown}).code))
}

export const getNativeFigureMarkerIndexes = (renderedText: string): number[] => {
  return Array.from(renderedText.matchAll(nativeFigureMarkerPattern), (match) => {
    return Number(match[1])
  })
}

const assertUniqueMarkers = (figureIndexes: number[]) => {
  const duplicate = figureIndexes.find((figureIndex, position) => {
    return figureIndexes.indexOf(figureIndex) !== position
  })

  if (duplicate !== undefined) {
    throw getNativeFigureImageError({
      code: nativeFigureImageErrorCodes.duplicateMarker,
      figureIndex: duplicate,
      imagePath: null,
      message: `Rendered full text contains the marker [figure:${duplicate}] more than once`,
    })
  }
}

const getMarkedAsset = (assets: NativeFigureImageAsset[], figureIndex: number): NativeFigureImageAsset => {
  const asset = assets.find((candidate) => {
    return candidate.index === figureIndex
  })

  if (!asset) {
    throw getNativeFigureImageError({
      code: nativeFigureImageErrorCodes.assetMissing,
      figureIndex,
      imagePath: null,
      message: `Rendered full text marks [figure:${figureIndex}] but full_text_assets has no figure with that index`,
    })
  }

  return asset
}

const getAssetMimeType = (asset: NativeFigureImageAsset): ProviderInvokeImage['mimeType'] => {
  const mimeType = getProviderImageMimeType(asset.imagePath)

  if (!mimeType) {
    throw getNativeFigureImageError({
      code: nativeFigureImageErrorCodes.fileUnsupported,
      figureIndex: asset.index,
      imagePath: asset.imagePath,
      message: `Figure ${asset.index} image ${asset.imagePath} is not a JPEG or PNG file`,
    })
  }

  return mimeType
}

const readAssetBytes = async (asset: NativeFigureImageAsset, cwd: string | undefined): Promise<Uint8Array> => {
  return readFile(resolveRuntimeFilePath({cwd, pathValue: asset.imagePath})).then(
    (bytes) => {
      return new Uint8Array(bytes)
    },
    (error: unknown) => {
      throw getNativeFigureImageError({
        code: nativeFigureImageErrorCodes.fileMissing,
        figureIndex: asset.index,
        imagePath: asset.imagePath,
        message: `Figure ${asset.index} image ${asset.imagePath} could not be read: ${error instanceof Error ? error.message : String(error)}`,
      })
    },
  )
}

const getSizeCheckedImage = (asset: NativeFigureImageAsset, image: ProviderInvokeImage): ProviderInvokeImage => {
  if (isProviderImageTooLarge(image)) {
    throw getNativeFigureImageError({
      code: nativeFigureImageErrorCodes.tooLarge,
      figureIndex: asset.index,
      imagePath: asset.imagePath,
      message: `Figure ${asset.index} image ${asset.imagePath} is ${getProviderImageBase64Length(image)} bytes base64-encoded after flattening; the per-image limit is ${PROVIDER_IMAGE_MAX_BASE64_BYTES} bytes (5 MB)`,
    })
  }

  return image
}

const getNativeFigureImageInput = async (
  asset: NativeFigureImageAsset,
  cwd: string | undefined,
): Promise<NativeFigureImageInput> => {
  const mimeType = getAssetMimeType(asset)
  const image = getSizeCheckedImage(asset, flattenFigureImage({bytes: await readAssetBytes(asset, cwd), mimeType}))

  return {bytes: image.bytes, figureIndex: asset.index, mimeType: image.mimeType}
}

export const getNativeFigureImageInputs = async ({
  assets,
  cwd,
  renderedText,
}: {
  assets: NativeFigureImageAsset[]
  cwd?: string
  renderedText: string
}): Promise<NativeFigureImageInput[]> => {
  const figureIndexes = getNativeFigureMarkerIndexes(renderedText)

  assertUniqueMarkers(figureIndexes)

  const markedAssets = figureIndexes.map((figureIndex) => {
    return getMarkedAsset(assets, figureIndex)
  })

  return Promise.all(
    markedAssets.map((asset) => {
      return getNativeFigureImageInput(asset, cwd)
    }),
  )
}

export const getNativeFigurePromptImages = (inputs: NativeFigureImageInput[]): ProviderInvokeImage[] => {
  return inputs.map((input) => {
    return {bytes: input.bytes, mimeType: input.mimeType}
  })
}
