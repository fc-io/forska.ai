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
  getStoredFullTextJudgingFigureAssets,
  renderFullTextForJudging,
} from './renderFullTextForJudging.ts'

const fixtures: Array<{converterKind: 'docling' | 'mineru'; name: CanonicalFixtureName}> = [
  {converterKind: 'mineru', name: 'arxiv-2111.06377'},
  {converterKind: 'docling', name: 'arxiv-2111.06377'},
  {converterKind: 'mineru', name: 'frontiers-fmed-2023-1283512'},
  {converterKind: 'docling', name: 'frontiers-fmed-2023-1283512'},
]

const target = {modelId: 'vlm-1', promptVersion: 'fig-desc-v1'}

const describedFor = <T extends Record<string, unknown>>(asset: T, modelId = target.modelId) => {
  return {...asset, descriptionModelId: modelId, descriptionPromptVersion: target.promptVersion}
}

const figure = (index: number, fields: Record<string, unknown> = {}) => {
  return {caption: `Caption ${index}`, imagePath: `assets/full-text-assets/a/fig-${index}.png`, index, ...fields}
}

test('rendering stored marker text per figure mode gives the builder bytes for that mode', () => {
  const results = fixtures.map(({converterKind, name}) => {
    const assets = withFixtureDescriptions(getCanonicalFixtureAssets(name, converterKind))
    const markerText = buildCanonicalFixture({assets, converterKind, figureMode: 'native_images', name}).text
    const judgingAssets = getFullTextJudgingFigureAssets(
      assets.map((asset) => {
        return describedFor(asset)
      }),
      target,
    )

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
    assets: getFullTextJudgingFigureAssets(
      [describedFor(figure(2, {caption: 'Flow chart', description: ' Boxes\n for  arms '}))],
      target,
    ),
    figureMode: 'descriptions',
    text: 'Intro.\n\nFigure 2: Flow chart\n[figure:2]\n\nResults.\n',
  })

  expect(rendered).toEqual({
    failedDescriptionFigureIndexes: [],
    missingDescriptionFigureIndexes: [],
    text: 'Intro.\n\nFigure 2: Flow chart\nDescription: Boxes for arms\n\nResults.\n',
  })
})

test('figure mode none drops the marker line and native images keep it', () => {
  const assets = getFullTextJudgingFigureAssets([{caption: null, index: 1}], null)
  const text = 'Figure 1\n[figure:1]\n\nBody text [figure:1] stays inline.\n'

  expect(renderFullTextForJudging({assets, figureMode: 'none', text}).text).toBe(
    'Figure 1\n\nBody text [figure:1] stays inline.\n',
  )
  expect(renderFullTextForJudging({assets, figureMode: 'native_images', text}).text).toBe(text)
})

test('only descriptions from the strategy model are used; others are pending or failed, never captions', () => {
  const assets = getFullTextJudgingFigureAssets(
    [
      describedFor(figure(1, {description: 'Shown.'})),
      describedFor(figure(2, {description: '  '})),
      figure(3),
      describedFor(figure(4, {description: 'From another model.'}), 'other-vlm'),
      figure(5, {
        descriptionAttemptModelId: target.modelId,
        descriptionAttemptPromptVersion: target.promptVersion,
        descriptionAttempts: 3,
      }),
      {caption: 'No crop', index: 6},
    ],
    target,
  )
  const rendered = renderFullTextForJudging({
    assets,
    figureMode: 'descriptions',
    text: [1, 2, 3, 4, 5, 6]
      .map((index) => {
        return `Figure ${index}: C\n[figure:${index}]`
      })
      .join('\n\n'),
  })

  expect(
    assets.map((asset) => {
      return asset.descriptionState
    }),
  ).toEqual(['described', 'needed', 'needed', 'needed', 'failed', 'failed'])
  expect(rendered.missingDescriptionFigureIndexes).toEqual([2, 3, 4])
  expect(rendered.failedDescriptionFigureIndexes).toEqual([5, 6])
  expect(rendered.text).not.toContain('From another model.')
  expect(rendered.text).toContain('Description: Shown.')
})

test('figure states are only computed for the descriptions mode and survive the snapshot round trip', () => {
  const rawAssets = [describedFor(figure(1, {description: 'Shown.'})), figure(2)]
  const withoutTarget = getFullTextJudgingFigureAssets(rawAssets, null)
  const withTarget = getFullTextJudgingFigureAssets(rawAssets, target)

  expect(withoutTarget).toEqual([
    {description: '', descriptionState: null, index: 1},
    {description: '', descriptionState: null, index: 2},
  ])
  expect(getStoredFullTextJudgingFigureAssets(JSON.parse(JSON.stringify(withTarget)))).toEqual(withTarget)
  expect(getStoredFullTextJudgingFigureAssets([{index: 1}])).toBeNull()
})

test('marker and asset mismatches are errors', () => {
  const assets = getFullTextJudgingFigureAssets([figure(1), figure(2)], target)
  const render = (text: string, figureMode: 'descriptions' | 'native_images' | 'none' = 'native_images') => {
    return () => {
      return renderFullTextForJudging({assets, figureMode, text})
    }
  }

  expect(render('[figure:1]\n[figure:3]\n')).toThrow(FullTextFigureMarkerError)
  expect(render('[figure:1]\n[figure:1]\n[figure:2]\n')).toThrow(FullTextFigureMarkerError)
  expect(render('Figure 2: B\n[figure:2]\n', 'descriptions')()).toEqual({
    failedDescriptionFigureIndexes: [],
    missingDescriptionFigureIndexes: [2],
    text: 'Figure 2: B\n[figure:2]\n',
  })
  expect(render('Figure 1: A\n\nFigure 2: B\n', 'none')()).toEqual({
    failedDescriptionFigureIndexes: [],
    missingDescriptionFigureIndexes: [],
    text: 'Figure 1: A\n\nFigure 2: B\n',
  })
  expect(() => {
    return getFullTextJudgingFigureAssets([{index: 'one'}], null)
  }).toThrow(FullTextFigureMarkerError)
})
