import {expect, test} from 'bun:test'

import {
  buildCanonicalFixture,
  type CanonicalFixtureName,
  getCanonicalFixtureAssets,
  withFixtureDescriptions,
} from '../../server/test/canonicalFullTextFixtures.ts'
import {
  FullTextFigureMarkerError,
  getFullTextJudgingFigureAssets,
  getMissingFigureDescriptionCount,
  renderFullTextForJudging,
} from './renderFullTextForJudging.ts'

const fixtures: Array<{converterKind: 'docling' | 'mineru'; name: CanonicalFixtureName}> = [
  {converterKind: 'mineru', name: 'arxiv-2111.06377'},
  {converterKind: 'docling', name: 'arxiv-2111.06377'},
  {converterKind: 'mineru', name: 'frontiers-fmed-2023-1283512'},
  {converterKind: 'docling', name: 'frontiers-fmed-2023-1283512'},
]

test('rendering stored marker text per figure mode gives the builder bytes for that mode', () => {
  const results = fixtures.map(({converterKind, name}) => {
    const assets = withFixtureDescriptions(getCanonicalFixtureAssets(name, converterKind))
    const markerText = buildCanonicalFixture({assets, converterKind, figureMode: 'native_images', name}).text
    const judgingAssets = getFullTextJudgingFigureAssets(assets)

    return ['none', 'descriptions', 'native_images'].map((figureMode) => {
      const mode = figureMode as 'descriptions' | 'native_images' | 'none'

      return (
        renderFullTextForJudging({assets: judgingAssets, figureMode: mode, text: markerText}).text
        === buildCanonicalFixture({assets, converterKind, figureMode: mode, name}).text
      )
    })
  })

  expect(results).toEqual(
    fixtures.map(() => {
      return [true, true, true]
    }),
  )
  expect(
    getCanonicalFixtureAssets('frontiers-fmed-2023-1283512', 'mineru').length,
    'fixture must contain figures for this test to mean anything',
  ).toBeGreaterThan(0)
})

test('descriptions are normalised like the builder and replace only the marker line', () => {
  const rendered = renderFullTextForJudging({
    assets: getFullTextJudgingFigureAssets([{caption: 'Flow chart', description: ' Boxes\n for  arms ', index: 2}]),
    figureMode: 'descriptions',
    text: 'Intro.\n\nFigure 2: Flow chart\n[figure:2]\n\nResults.\n',
  })

  expect(rendered).toEqual({
    missingDescriptionFigureIndexes: [],
    text: 'Intro.\n\nFigure 2: Flow chart\nDescription: Boxes for arms\n\nResults.\n',
  })
})

test('figure mode none drops the marker line and native images keep it', () => {
  const assets = getFullTextJudgingFigureAssets([{caption: null, index: 1}])
  const text = 'Figure 1\n[figure:1]\n\nBody text [figure:1] stays inline.\n'

  expect(renderFullTextForJudging({assets, figureMode: 'none', text}).text).toBe(
    'Figure 1\n\nBody text [figure:1] stays inline.\n',
  )
  expect(renderFullTextForJudging({assets, figureMode: 'native_images', text}).text).toBe(text)
})

test('missing descriptions are reported, never replaced by captions', () => {
  const assets = getFullTextJudgingFigureAssets([
    {caption: 'A', description: 'Shown.', index: 1},
    {caption: 'B', description: '  ', index: 2},
    {caption: 'C', index: 3},
  ])
  const rendered = renderFullTextForJudging({
    assets,
    figureMode: 'descriptions',
    text: 'Figure 1: A\n[figure:1]\n\nFigure 2: B\n[figure:2]\n\nFigure 3: C\n[figure:3]\n',
  })

  expect(rendered.missingDescriptionFigureIndexes).toEqual([2, 3])
  expect(getMissingFigureDescriptionCount(JSON.stringify(assets))).toBe(2)
  expect(getMissingFigureDescriptionCount(null)).toBe(0)
})

test('marker and asset mismatches are errors', () => {
  const assets = getFullTextJudgingFigureAssets([{index: 1}, {index: 2}])
  const render = (text: string, figureMode: 'descriptions' | 'native_images' | 'none' = 'native_images') => {
    return () => {
      return renderFullTextForJudging({assets, figureMode, text})
    }
  }

  expect(render('[figure:1]\n[figure:3]\n')).toThrow(FullTextFigureMarkerError)
  expect(render('[figure:1]\n[figure:1]\n[figure:2]\n')).toThrow(FullTextFigureMarkerError)
  expect(render('Figure 2: B\n[figure:2]\n', 'descriptions')()).toEqual({
    missingDescriptionFigureIndexes: [2],
    text: 'Figure 2: B\n[figure:2]\n',
  })
  expect(render('Figure 1: A\n\nFigure 2: B\n', 'none')()).toEqual({
    missingDescriptionFigureIndexes: [],
    text: 'Figure 1: A\n\nFigure 2: B\n',
  })
  expect(() => {
    return getFullTextJudgingFigureAssets([{index: 'one'}])
  }).toThrow(FullTextFigureMarkerError)
})
