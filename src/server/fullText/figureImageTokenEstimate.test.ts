import {expect, test} from 'bun:test'
import {PNG} from 'pngjs'

import {flattenFigureImage, isFigureImageEncodingError} from './figureImageEncoding.ts'
import {
  type FigureImageDimensions,
  getFigureImageDimensions,
  getFigureImagePatchCount,
  getFigureImageTokenEstimate,
  getFigureImageTokenEstimates,
  IMAGE_TOKEN_ESTIMATE_VERSION,
} from './figureImageTokenEstimate.ts'

const estimate = (width: number, height: number): number => {
  return getFigureImageTokenEstimate({dimensions: {height, width}, version: IMAGE_TOKEN_ESTIMATE_VERSION})
}

const parseDimensions = (value: string): FigureImageDimensions => {
  const [width, height] = value.split('x').map(Number)

  return {height: height ?? 0, width: width ?? 0}
}

const getArticleEstimate = (dimensions: string): number => {
  return dimensions
    .split(' ')
    .map(parseDimensions)
    .reduce((total, value) => {
      return total + getFigureImageTokenEstimate({dimensions: value, version: IMAGE_TOKEN_ESTIMATE_VERSION})
    }, 0)
}

const getJpegHeader = ({height, width}: FigureImageDimensions, segmentsBeforeFrame: number[][] = []): Uint8Array => {
  const frame = [0xff, 0xc0, 0, 17, 8, height >> 8, height & 255, width >> 8, width & 255, 3, 1, 0x22, 0, 2, 0x11, 1, 3]

  return Uint8Array.from([0xff, 0xd8, ...segmentsBeforeFrame.flat(), ...frame, 0x11, 1, 0xff, 0xd9])
}

const getRgbaPng = ({height, width}: FigureImageDimensions): Uint8Array => {
  const png = new PNG({height, width})

  png.data.fill(0)

  return new Uint8Array(PNG.sync.write(png, {colorType: 6}))
}

test('img-tok-v1 follows the documented gpt-6-astra high-detail examples plus 6 framing tokens', () => {
  expect(IMAGE_TOKEN_ESTIMATE_VERSION).toBe('img-tok-v1')
  expect(getFigureImagePatchCount({height: 1024, width: 1024})).toBe(1024)
  expect(estimate(1024, 1024)).toBe(1229 + 6)
  expect(getFigureImagePatchCount({height: 2048, width: 2048})).toBe(2500)
  expect(estimate(2048, 2048)).toBe(3000 + 6)
  expect(getFigureImagePatchCount({height: 512, width: 4096})).toBe(2048)
  expect(estimate(4096, 512)).toBe(2458 + 6)
})

test('1.2 tokens per patch rounds up in integer arithmetic', () => {
  expect(estimate(160, 32)).toBe(6 + 6)
  expect(estimate(32, 32)).toBe(2 + 6)
  expect(estimate(33, 32)).toBe(3 + 6)
  expect(estimate(1, 1)).toBe(2 + 6)
})

test('the patch budget caps one figure at 3,006 tokens and keeps patches within it', () => {
  const sizes: Array<[number, number]> = [
    [1326, 1280],
    [3000, 2000],
    [6000, 6000],
    [10_000, 300],
    [70_000, 40],
  ]

  expect(
    sizes.map(([width, height]) => {
      return getFigureImagePatchCount({height, width}) <= 2500 && estimate(width, height) <= 3006
    }),
  ).toEqual(
    sizes.map(() => {
      return true
    }),
  )
  expect(getFigureImagePatchCount({height: 1280, width: 1326})).toBe(1680)
})

test('frozen calibration: the 2026-10-18 live Codex GPT-6-Astra run (prompt-token delta native images vs text only)', () => {
  // Measured deltas include one constant extra token per request (see e2e-live-run-2.md, issue 7).
  const articles = [
    {dimensions: '1383x993', measured: 1696},
    {dimensions: '1357x642', measured: 1090},
    {dimensions: '1326x1280 1013x709', measured: 2912},
    {dimensions: '902x671 909x767 738x560 745x559', measured: 2626},
    {dimensions: '664x794 954x1273 1107x775 729x492', measured: 3587},
    {
      dimensions:
        '936x344 293x414 259x201 333x272 294x289 285x267 329x271 274x261 606x463 508x542 513x540 361x84 532x791 '
        + '1251x465 660x368 327x370 530x379 407x384 285x344 278x223 327x221 274x220 329x223 1092x269 912x566',
      measured: 5962,
    },
  ]

  expect(
    articles.map(({dimensions}) => {
      return getArticleEstimate(dimensions)
    }),
  ).toEqual([1696, 1090, 2912, 2629, 3586, 5979])
  expect(
    articles.every(({dimensions, measured}) => {
      const residual = getArticleEstimate(dimensions) - (measured - 1)

      return residual >= 0 && residual <= 0.01 * measured
    }),
  ).toBe(true)
})

test('dimensions come from the PNG header and the JPEG frame header', () => {
  expect(getFigureImageDimensions(getRgbaPng({height: 7, width: 13}))).toEqual({height: 7, width: 13})
  expect(getFigureImageDimensions(getJpegHeader({height: 671, width: 902}))).toEqual({height: 671, width: 902})
  expect(
    getFigureImageDimensions(
      getJpegHeader({height: 300, width: 2000}, [
        [0xff, 0xe0, 0, 4, 0x4a, 0x46],
        [0xff, 0xff, 0xc4, 0, 3, 0],
        [0xff, 0xdb, 0, 3, 0],
      ]),
    ),
  ).toEqual({height: 300, width: 2000})
})

test('flattening a transparent PNG keeps its dimensions, so crop and sent image estimate the same', () => {
  const bytes = getRgbaPng({height: 40, width: 90})
  const flattened = flattenFigureImage({bytes, mimeType: 'image/png'})

  expect(flattened.bytes).not.toBe(bytes)
  expect(getFigureImageDimensions(flattened.bytes)).toEqual(getFigureImageDimensions(bytes))
})

test('unreadable images are encoding errors and unknown versions are refused by name', () => {
  const unreadable = [
    Uint8Array.of(1, 2, 3),
    Uint8Array.of(0xff, 0xd8, 0xff, 0xda, 0, 2),
    getJpegHeader({height: 0, width: 5}),
  ]

  expect(
    unreadable.map((bytes) => {
      try {
        getFigureImageDimensions(bytes)
        return 'read'
      } catch (error) {
        return isFigureImageEncodingError(error) ? 'encoding error' : 'other'
      }
    }),
  ).toEqual(['encoding error', 'encoding error', 'encoding error'])
  expect(() => {
    return getFigureImageTokenEstimate({dimensions: {height: 1, width: 1}, version: 'img-tok-v0'})
  }).toThrow('Image token estimate img-tok-v0 is not part of this build (known: img-tok-v1)')
})

test('estimates are keyed by figure index', () => {
  expect(
    getFigureImageTokenEstimates({
      images: [
        {bytes: getJpegHeader({height: 993, width: 1383}), figureIndex: 3},
        {bytes: getRgbaPng({height: 32, width: 160}), figureIndex: 7},
      ],
      version: IMAGE_TOKEN_ESTIMATE_VERSION,
    }),
  ).toEqual(
    new Map([
      [3, 1696],
      [7, 12],
    ]),
  )
})
