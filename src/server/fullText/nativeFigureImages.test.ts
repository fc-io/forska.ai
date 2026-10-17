import {copyFile, mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import {afterAll, beforeAll, expect, test} from 'bun:test'

import {pngHasTransparency} from './figureImageEncoding.ts'
import {
  getNativeFigureImageInputs,
  getNativeFigureMarkerIndexes,
  getNativeFigurePromptImages,
  isNativeFigureImageError,
  nativeFigureImageErrorCodes,
} from './nativeFigureImages.ts'

const jpegBytes = Uint8Array.of(0xff, 0xd8, 0xff, 0xe0, 0, 16, 1, 2, 3)
const assetDir = 'assets/full-text-assets/article-1'
const state = {cwd: ''}

const assets = [
  {caption: 'First', imagePath: `${assetDir}/fig-1.jpg`, index: 1},
  {caption: 'Second', imagePath: `${assetDir}/fig-2.png`, index: 2},
  {caption: 'Third', imagePath: `${assetDir}/fig-3.jpg`, index: 3},
  {caption: 'Gone', imagePath: `${assetDir}/fig-4.jpg`, index: 4},
  {caption: 'Wrong type', imagePath: `${assetDir}/fig-5.webp`, index: 5},
]

const getRejection = async (promise: Promise<unknown>): Promise<unknown> => {
  return promise.then(
    () => {
      return null
    },
    (error: unknown) => {
      return error
    },
  )
}

beforeAll(async () => {
  state.cwd = await mkdtemp(path.join(os.tmpdir(), 'forska-native-figures-'))
  await mkdir(path.join(state.cwd, assetDir), {recursive: true})
  await writeFile(path.join(state.cwd, assetDir, 'fig-1.jpg'), jpegBytes)
  await copyFile(
    new URL('./fixtures/figureImages/transparent-3x2.png', import.meta.url),
    path.join(state.cwd, assetDir, 'fig-2.png'),
  )
  await writeFile(path.join(state.cwd, assetDir, 'fig-3.jpg'), jpegBytes)
  await writeFile(path.join(state.cwd, assetDir, 'fig-5.webp'), 'RIFF')
})

afterAll(async () => {
  await rm(state.cwd, {force: true, recursive: true})
})

test('markers are read in document order and only when they stand on their own line', () => {
  expect(
    getNativeFigureMarkerIndexes('Figure 2: Second\n[figure:2]\n\nSee [figure:3] inline.\n\nFigure 1\n[figure:1]\n'),
  ).toEqual([2, 1])
})

test('images follow the [figure:N] marker order of the rendered text, flattened, unmarked figures left out', async () => {
  const inputs = await getNativeFigureImageInputs({
    assets,
    cwd: state.cwd,
    renderedText: '## Results\n\nFigure 2: Second\n[figure:2]\n\nText.\n\nFigure 1: First\n[figure:1]',
  })

  expect(
    inputs.map((input) => {
      return [input.figureIndex, input.mimeType]
    }),
  ).toEqual([
    [2, 'image/png'],
    [1, 'image/jpeg'],
  ])
  expect(pngHasTransparency(inputs[0]?.bytes ?? new Uint8Array())).toBe(false)
  expect(inputs[1]?.bytes).toEqual(jpegBytes)
  expect(
    getNativeFigurePromptImages(inputs).map((image) => {
      return Object.keys(image).sort()
    }),
  ).toEqual([
    ['bytes', 'mimeType'],
    ['bytes', 'mimeType'],
  ])
})

test('text without markers yields no images', async () => {
  expect(await getNativeFigureImageInputs({assets, cwd: state.cwd, renderedText: 'Figure 1: First'})).toEqual([])
})

test('a missing crop, an unknown figure, a duplicate marker and a non-image file raise typed errors', async () => {
  const errors = await Promise.all(
    ['[figure:4]', '[figure:9]', '[figure:1]\n\n[figure:1]', '[figure:5]'].map((renderedText) => {
      return getRejection(getNativeFigureImageInputs({assets, cwd: state.cwd, renderedText}))
    }),
  )

  expect(errors.every(isNativeFigureImageError)).toBe(true)
  expect(
    errors.map((error) => {
      return isNativeFigureImageError(error) ? [error.code, error.figureIndex, error.imagePath] : null
    }),
  ).toEqual([
    [nativeFigureImageErrorCodes.fileMissing, 4, `${assetDir}/fig-4.jpg`],
    [nativeFigureImageErrorCodes.assetMissing, 9, null],
    [nativeFigureImageErrorCodes.duplicateMarker, 1, null],
    [nativeFigureImageErrorCodes.fileUnsupported, 5, `${assetDir}/fig-5.webp`],
  ])
})
