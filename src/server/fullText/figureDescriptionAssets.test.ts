import {expect, test} from 'bun:test'

import {
  getAssetWithoutFigureDescription,
  getDescribedFigureAsset,
  getFailedFigureAsset,
  getFigureDescriptionAssetState,
  getFigureDescriptionCounts,
  isFigureDescriptionAsset,
  MAX_FIGURE_DESCRIPTION_ATTEMPTS,
} from './figureDescriptionAssets.ts'

const target = {modelId: 'model-vlm', promptVersion: 'fig-desc-v1'}
const asset = {
  bbox: [1, 2, 3, 4],
  caption: 'Figure 1. Flow.',
  imagePath: 'assets/full-text-assets/a/fig-1.jpg',
  index: 1,
  page: 2,
}
const failedAt = new Date('2026-10-17T10:00:00.000Z')

test('a description counts only for the current model and prompt version', () => {
  const described = getDescribedFigureAsset({asset, describedAt: failedAt, description: 'Flow diagram.', target})

  expect(described).toEqual({
    ...asset,
    describedAt: '2026-10-17T10:00:00.000Z',
    description: 'Flow diagram.',
    descriptionModelId: 'model-vlm',
    descriptionPromptVersion: 'fig-desc-v1',
  })
  expect(getFigureDescriptionAssetState(described, target)).toBe('described')
  expect(getFigureDescriptionAssetState(described, {...target, modelId: 'model-next'})).toBe('needed')
  expect(getFigureDescriptionAssetState(described, {...target, promptVersion: 'fig-desc-v2'})).toBe('needed')
  expect(getFigureDescriptionAssetState({...described, description: ' '}, target)).toBe('needed')
  expect(getFigureDescriptionAssetState(asset, target)).toBe('needed')
})

test('transient failures become permanent on the third attempt for the same target only', () => {
  const first = getFailedFigureAsset({asset, error: 'HTTP 500', failedAt, permanent: false, target})
  const second = getFailedFigureAsset({asset: first, error: 'HTTP 500', failedAt, permanent: false, target})
  const third = getFailedFigureAsset({asset: second, error: 'HTTP 500', failedAt, permanent: false, target})
  const otherTarget = {...target, modelId: 'model-next'}

  expect(first).toMatchObject({
    descriptionAttemptModelId: 'model-vlm',
    descriptionAttemptPromptVersion: 'fig-desc-v1',
    descriptionAttempts: 1,
    descriptionError: 'HTTP 500',
    descriptionFailedAt: '2026-10-17T10:00:00.000Z',
  })
  expect(getFigureDescriptionAssetState(second, target)).toBe('needed')
  expect(third.descriptionAttempts).toBe(MAX_FIGURE_DESCRIPTION_ATTEMPTS)
  expect(getFigureDescriptionAssetState(third, target)).toBe('failed')
  expect(getFigureDescriptionAssetState(third, otherTarget)).toBe('needed')
  expect(
    getFailedFigureAsset({asset: third, error: 'x', failedAt, permanent: false, target: otherTarget}),
  ).toMatchObject({descriptionAttemptModelId: 'model-next', descriptionAttempts: 1})
})

test('permanent failures fail at once; success clears the failure fields', () => {
  const permanent = getFailedFigureAsset({asset, error: 'ENOENT', failedAt, permanent: true, target})
  const recovered = getDescribedFigureAsset({asset: permanent, describedAt: failedAt, description: 'Chart.', target})

  expect(permanent.descriptionAttempts).toBe(MAX_FIGURE_DESCRIPTION_ATTEMPTS)
  expect(getFigureDescriptionAssetState(permanent, target)).toBe('failed')
  expect(Object.keys(recovered).sort()).toEqual(
    [
      'bbox',
      'caption',
      'describedAt',
      'description',
      'descriptionModelId',
      'descriptionPromptVersion',
      'imagePath',
      'index',
      'page',
    ].sort(),
  )
  expect(getAssetWithoutFigureDescription(recovered)).toEqual(asset)
})

test('counts and asset shape checks', () => {
  const described = getDescribedFigureAsset({asset, describedAt: failedAt, description: 'Chart.', target})
  const failed = getFailedFigureAsset({asset: {...asset, index: 2}, error: 'x', failedAt, permanent: true, target})

  expect(getFigureDescriptionCounts([described, failed, {...asset, index: 3}], target)).toEqual({
    described: 1,
    failed: 1,
    needed: 1,
    total: 3,
  })
  expect(isFigureDescriptionAsset(asset)).toBe(true)
  expect(isFigureDescriptionAsset({...asset, imagePath: null})).toBe(false)
  expect(isFigureDescriptionAsset({...asset, index: 1.5})).toBe(false)
  expect(isFigureDescriptionAsset([asset])).toBe(false)
})
