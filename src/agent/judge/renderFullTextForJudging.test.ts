import {expect, test} from 'bun:test'

import {
  buildCanonicalFixture,
  type CanonicalFixtureName,
  getCanonicalFixtureAssets,
} from '../../server/test/canonicalFullTextFixtures.ts'
import {
  FullTextFigureMarkerError,
  getFullTextJudgingFigureAssets,
  getStoredFullTextJudgingFigureAssets,
  renderFullTextForJudging,
} from './renderFullTextForJudging.ts'

const fixtures: Array<{converterKind: 'docling' | 'mineru'; name: CanonicalFixtureName}> = [
  {converterKind: 'mineru', name: 'arxiv-2111.06377'},
  {converterKind: 'docling', name: 'arxiv-2111.06377'},
  {converterKind: 'mineru', name: 'frontiers-fmed-2023-1283512'},
  {converterKind: 'docling', name: 'frontiers-fmed-2023-1283512'},
]

const figure = (index: number, fields: Record<string, unknown> = {}) => {
  return {caption: `Caption ${index}`, imagePath: `assets/full-text-assets/a/fig-${index}.png`, index, ...fields}
}

test('rendering stored marker text per figure mode gives the builder bytes for that mode', () => {
  const results = fixtures.map(({converterKind, name}) => {
    const assets = getCanonicalFixtureAssets(name, converterKind)
    const markerText = buildCanonicalFixture({assets, converterKind, figureMode: 'native_images', name}).text
    const judgingAssets = getFullTextJudgingFigureAssets(assets)

    return (['none', 'native_images'] as const).map((figureMode) => {
      return (
        renderFullTextForJudging({assets: judgingAssets, figureMode, text: markerText})
        === buildCanonicalFixture({assets, converterKind, figureMode, name}).text
      )
    })
  })

  expect(results).toEqual(
    fixtures.map(() => {
      return [true, true]
    }),
  )
  expect(
    getCanonicalFixtureAssets('frontiers-fmed-2023-1283512', 'mineru').length,
    'fixture must contain figures for this test to mean anything',
  ).toBeGreaterThan(0)
})

test('text only keeps the Figure N caption lines and drops the marker line; images keep the marker', () => {
  const assets = getFullTextJudgingFigureAssets([figure(1, {caption: null}), figure(2, {caption: 'Flow chart'})])
  const text =
    'Intro.\n\nFigure 1\n[figure:1]\n\nFigure 2: Flow chart\n[figure:2]\n\nBody text [figure:1] stays inline.\n'

  expect(renderFullTextForJudging({assets, figureMode: 'none', text})).toBe(
    'Intro.\n\nFigure 1\n\nFigure 2: Flow chart\n\nBody text [figure:1] stays inline.\n',
  )
  expect(renderFullTextForJudging({assets, figureMode: 'native_images', text})).toBe(text)
})

test('stored description fields on an asset never reach the rendered text', () => {
  const assets = getFullTextJudgingFigureAssets([
    figure(1, {description: 'Boxes for arms.', descriptionModelId: 'vlm-1', descriptionPromptVersion: 'fig-desc-v1'}),
  ])
  const text = 'Figure 1: Caption 1\n[figure:1]\n'

  expect(assets).toEqual([{imagePath: 'assets/full-text-assets/a/fig-1.png', index: 1}])
  expect(renderFullTextForJudging({assets, figureMode: 'none', text})).toBe('Figure 1: Caption 1\n')
  expect(renderFullTextForJudging({assets, figureMode: 'native_images', text})).toBe(text)
})

test('figure assets keep index and image path and survive the snapshot round trip', () => {
  const assets = getFullTextJudgingFigureAssets([figure(1), {caption: 'No crop', index: 2}])

  expect(assets).toEqual([
    {imagePath: 'assets/full-text-assets/a/fig-1.png', index: 1},
    {imagePath: null, index: 2},
  ])
  expect(getStoredFullTextJudgingFigureAssets(JSON.parse(JSON.stringify(assets)))).toEqual(assets)
  expect(
    getStoredFullTextJudgingFigureAssets([{description: '', descriptionState: null, imagePath: null, index: 1}]),
  ).toEqual([{imagePath: null, index: 1}])
  expect(getStoredFullTextJudgingFigureAssets([{index: 1}])).toBeNull()
})

test('marker and asset mismatches are errors', () => {
  const assets = getFullTextJudgingFigureAssets([figure(1), figure(2)])
  const render = (text: string, figureMode: 'native_images' | 'none' = 'native_images') => {
    return () => {
      return renderFullTextForJudging({assets, figureMode, text})
    }
  }

  expect(render('[figure:1]\n[figure:3]\n')).toThrow(FullTextFigureMarkerError)
  expect(render('[figure:1]\n[figure:1]\n[figure:2]\n')).toThrow(FullTextFigureMarkerError)
  expect(render('[figure:1]\n[figure:3]\n', 'none')).toThrow(FullTextFigureMarkerError)
  expect(render('Figure 1: A\n\nFigure 2: B\n', 'none')()).toBe('Figure 1: A\n\nFigure 2: B\n')
  expect(() => {
    return getFullTextJudgingFigureAssets([{index: 'one'}])
  }).toThrow(FullTextFigureMarkerError)
})
