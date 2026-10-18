import {zlibSync} from 'fflate'
import {PNG} from 'pngjs'

import {type ProviderInvokeImage} from '../providers/providerTypes.ts'
import {getFigureImageEncodingError} from './figureImageEncodingError.ts'

export {
  type FigureImageEncodingError,
  figureImageEncodingInvalidCode,
  isFigureImageEncodingError,
} from './figureImageEncodingError.ts'

export const FIGURE_IMAGE_FLATTEN_BACKGROUND = [255, 255, 255] as const

const pngSignature = [137, 80, 78, 71, 13, 10, 26, 10]
const jpegSignature = [0xff, 0xd8, 0xff]
const pngColorTypeOffset = 25
const pngChunkHeaderLength = 8
const pngChunkCrcLength = 4
const pngAlphaColorTypes = new Set([4, 6])
const rgbChannels = 3
const rgbaChannels = 4
const pngPaethFilterType = 4

const crc32Table = Uint32Array.from({length: 256}, (_, value) => {
  return Array.from({length: 8}).reduce<number>((crc) => {
    return crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1
  }, value)
})

const hasSignature = (bytes: Uint8Array, signature: number[]): boolean => {
  return (
    bytes.length >= signature.length
    && signature.every((value, index) => {
      return bytes[index] === value
    })
  )
}

const getUint32 = (bytes: Uint8Array, offset: number): number => {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset)
}

const getChunkType = (bytes: Uint8Array, offset: number): string => {
  return String.fromCharCode(...bytes.subarray(offset + 4, offset + pngChunkHeaderLength))
}

const getPngChunkTypesBeforeImageData = (bytes: Uint8Array, offset: number = pngSignature.length): string[] => {
  const type = offset + pngChunkHeaderLength <= bytes.length ? getChunkType(bytes, offset) : 'IEND'
  const nextOffset =
    offset + pngChunkHeaderLength + (type === 'IEND' ? 0 : getUint32(bytes, offset)) + pngChunkCrcLength

  return type === 'IDAT' || type === 'IEND' ? [] : [type, ...getPngChunkTypesBeforeImageData(bytes, nextOffset)]
}

export const pngHasTransparency = (bytes: Uint8Array): boolean => {
  return (
    pngAlphaColorTypes.has(bytes[pngColorTypeOffset] ?? -1) || getPngChunkTypesBeforeImageData(bytes).includes('tRNS')
  )
}

const decodePng = (bytes: Uint8Array) => {
  try {
    return PNG.sync.read(Buffer.from(bytes))
  } catch (error) {
    throw getFigureImageEncodingError(
      `Figure PNG could not be decoded: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

const getRgbOnWhite = (rgba: Uint8Array, width: number, height: number): Uint8Array => {
  return Uint8Array.from({length: width * height * rgbChannels}, (_, position) => {
    const pixel = Math.floor(position / rgbChannels) * rgbaChannels
    const alpha = rgba[pixel + rgbaChannels - 1] ?? 0
    const channel = rgba[pixel + (position % rgbChannels)] ?? 0
    const background = FIGURE_IMAGE_FLATTEN_BACKGROUND[position % rgbChannels] ?? 255

    return Math.round((channel * alpha + background * (255 - alpha)) / 255)
  })
}

const getPaethPredictor = (left: number, up: number, upLeft: number): number => {
  const estimate = left + up - upLeft
  const leftDistance = Math.abs(estimate - left)
  const upDistance = Math.abs(estimate - up)
  const upLeftDistance = Math.abs(estimate - upLeft)

  return leftDistance <= upDistance && leftDistance <= upLeftDistance
    ? left
    : upDistance <= upLeftDistance
      ? up
      : upLeft
}

const getPaethFilteredScanlines = (rgb: Uint8Array, width: number, height: number): Uint8Array => {
  const stride = width * rgbChannels
  const lineLength = stride + 1

  return Uint8Array.from({length: height * lineLength}, (_, position) => {
    const row = Math.floor(position / lineLength)
    const column = (position % lineLength) - 1
    const index = row * stride + column
    const left = column >= rgbChannels ? (rgb[index - rgbChannels] ?? 0) : 0
    const up = row > 0 ? (rgb[index - stride] ?? 0) : 0
    const upLeft = row > 0 && column >= rgbChannels ? (rgb[index - stride - rgbChannels] ?? 0) : 0

    return column < 0 ? pngPaethFilterType : ((rgb[index] ?? 0) - getPaethPredictor(left, up, upLeft)) & 0xff
  })
}

const getCrc32 = (bytes: Uint8Array): number => {
  return (
    (bytes.reduce((crc, byte) => {
      return (crc32Table[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8)
    }, 0xffffffff)
      ^ 0xffffffff)
    >>> 0
  )
}

const getUint32Bytes = (value: number): Uint8Array => {
  return Uint8Array.of(value >>> 24, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff)
}

const concatBytes = (parts: Uint8Array[]): Uint8Array => {
  const length = parts.reduce((total, part) => {
    return total + part.length
  }, 0)

  return parts.reduce(
    (state, part) => {
      state.bytes.set(part, state.offset)
      return {bytes: state.bytes, offset: state.offset + part.length}
    },
    {bytes: new Uint8Array(length), offset: 0},
  ).bytes
}

const getPngChunk = (type: string, data: Uint8Array): Uint8Array => {
  const typeAndData = concatBytes([new TextEncoder().encode(type), data])

  return concatBytes([getUint32Bytes(data.length), typeAndData, getUint32Bytes(getCrc32(typeAndData))])
}

const getRgbPngHeader = (width: number, height: number): Uint8Array => {
  return concatBytes([getUint32Bytes(width), getUint32Bytes(height), Uint8Array.of(8, 2, 0, 0, 0)])
}

export const encodeRgbPng = ({height, rgb, width}: {height: number; rgb: Uint8Array; width: number}): Uint8Array => {
  const imageData = zlibSync(getPaethFilteredScanlines(rgb, width, height), {level: 6, mem: 8})

  return concatBytes([
    Uint8Array.from(pngSignature),
    getPngChunk('IHDR', getRgbPngHeader(width, height)),
    getPngChunk('IDAT', imageData),
    getPngChunk('IEND', new Uint8Array()),
  ])
}

const getFlattenedPngBytes = (bytes: Uint8Array): Uint8Array => {
  const decoded = decodePng(bytes)

  return encodeRgbPng({
    height: decoded.height,
    rgb: getRgbOnWhite(new Uint8Array(decoded.data), decoded.width, decoded.height),
    width: decoded.width,
  })
}

const getFlattenedPng = (image: ProviderInvokeImage): ProviderInvokeImage => {
  if (!hasSignature(image.bytes, pngSignature)) {
    throw getFigureImageEncodingError('Figure image is labelled image/png but is not a PNG file')
  }

  return pngHasTransparency(image.bytes) ? {bytes: getFlattenedPngBytes(image.bytes), mimeType: 'image/png'} : image
}

const getCheckedJpeg = (image: ProviderInvokeImage): ProviderInvokeImage => {
  if (!hasSignature(image.bytes, jpegSignature)) {
    throw getFigureImageEncodingError('Figure image is labelled image/jpeg but is not a JPEG file')
  }

  return image
}

export const flattenFigureImage = (image: ProviderInvokeImage): ProviderInvokeImage => {
  return image.mimeType === 'image/png' ? getFlattenedPng(image) : getCheckedJpeg(image)
}

export const flattenFigureImages = (images: ProviderInvokeImage[]): ProviderInvokeImage[] => {
  return images.map(flattenFigureImage)
}
