import {createHash} from 'node:crypto'
import {readFileSync} from 'node:fs'

import {expect, test} from 'bun:test'
import {PNG} from 'pngjs'

import {
  encodeRgbPng,
  figureImageEncodingInvalidCode,
  flattenFigureImage,
  flattenFigureImages,
  isFigureImageEncodingError,
  pngHasTransparency,
} from './figureImageEncoding.ts'

const readFixture = (name: string): Uint8Array => {
  return new Uint8Array(readFileSync(new URL(`./fixtures/figureImages/${name}`, import.meta.url)))
}

const getSha256 = (bytes: Uint8Array): string => {
  return createHash('sha256').update(bytes).digest('hex')
}

const getRgbPixels = (bytes: Uint8Array): number[][] => {
  const decoded = PNG.sync.read(Buffer.from(bytes))

  return Array.from({length: decoded.width * decoded.height}, (_, pixel) => {
    return Array.from(decoded.data.subarray(pixel * 4, pixel * 4 + 3))
  })
}

const getThrown = (operation: () => unknown): unknown => {
  try {
    return operation()
  } catch (error) {
    return error
  }
}

test('a transparent PNG is flattened onto white into an opaque RGB PNG with frozen bytes', () => {
  const transparent = readFixture('transparent-3x2.png')
  const flattened = flattenFigureImage({bytes: transparent, mimeType: 'image/png'})

  expect(pngHasTransparency(transparent)).toBe(true)
  expect(flattened.mimeType).toBe('image/png')
  expect(flattened.bytes[25]).toBe(2)
  expect(pngHasTransparency(flattened.bytes)).toBe(false)
  expect(getRgbPixels(flattened.bytes)).toEqual([
    [255, 0, 0],
    [127, 191, 255],
    [255, 255, 255],
    [10, 20, 30],
    [191, 191, 191],
    [255, 254, 254],
  ])
  expect(getSha256(flattened.bytes)).toBe('d43bf9473dcc2268d54caa71fc0d1639d7425f1a933486802aa62c3a72894903')
})

test('flattening is idempotent: an opaque PNG and an already flattened PNG pass through unchanged', () => {
  const opaque = {bytes: readFixture('opaque-2x1.png'), mimeType: 'image/png' as const}
  const flattened = flattenFigureImage({bytes: readFixture('transparent-3x2.png'), mimeType: 'image/png'})

  expect(flattenFigureImage(opaque)).toBe(opaque)
  expect(flattenFigureImage(flattened)).toBe(flattened)
})

test('JPEG images pass through unchanged', () => {
  const jpeg = {bytes: Uint8Array.of(0xff, 0xd8, 0xff, 0xe0, 0, 16), mimeType: 'image/jpeg' as const}

  expect(flattenFigureImages([jpeg])[0]).toBe(jpeg)
})

test('a tRNS chunk before the image data marks an RGB or palette PNG as transparent', () => {
  const opaque = readFixture('opaque-2x1.png')
  const withTransparencyChunk = Uint8Array.from([
    ...opaque.subarray(0, 33),
    ...[0, 0, 0, 6],
    ...new TextEncoder().encode('tRNS'),
    ...[0, 1, 0, 2, 0, 3],
    ...[0, 0, 0, 0],
    ...opaque.subarray(33),
  ])

  expect(pngHasTransparency(opaque)).toBe(false)
  expect(pngHasTransparency(withTransparencyChunk)).toBe(true)
})

test('encodeRgbPng writes a decodable 8-bit RGB PNG', () => {
  const rgb = Uint8Array.of(1, 2, 3, 4, 5, 6, 7, 8, 9, 250, 251, 252)

  expect(getRgbPixels(encodeRgbPng({height: 2, rgb, width: 2}))).toEqual([
    [1, 2, 3],
    [4, 5, 6],
    [7, 8, 9],
    [250, 251, 252],
  ])
})

test('bytes that do not match their mime type or do not decode raise a typed error', () => {
  const errors = [
    getThrown(() => {
      return flattenFigureImage({bytes: Uint8Array.of(0xff, 0xd8, 0xff), mimeType: 'image/png'})
    }),
    getThrown(() => {
      return flattenFigureImage({bytes: readFixture('opaque-2x1.png'), mimeType: 'image/jpeg'})
    }),
    getThrown(() => {
      return flattenFigureImage({bytes: readFixture('transparent-3x2.png').subarray(0, 40), mimeType: 'image/png'})
    }),
  ]

  expect(errors.every(isFigureImageEncodingError)).toBe(true)
  expect(
    errors.map((error) => {
      return (error as {code?: string}).code
    }),
  ).toEqual([figureImageEncodingInvalidCode, figureImageEncodingInvalidCode, figureImageEncodingInvalidCode])
})
