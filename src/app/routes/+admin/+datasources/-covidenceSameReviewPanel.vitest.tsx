// @vitest-environment happy-dom

import {createSignal} from 'solid-js'
import {render} from 'solid-js/web'
import {afterEach, describe, expect, test} from 'vitest'

import {type CovidenceSameReviewAnalysis, CovidenceSameReviewPanel} from './-covidenceSameReviewPanel.tsx'

const baseRoute = {
  dataSourceId: 'ds-old',
  dataSourceTitle: 'cov 6 | 3',
  importRoute: 'covidence:ds-old',
  matchedRecordCount: 12_400,
  share: 0.995,
}
const sameReview: CovidenceSameReviewAnalysis = {
  matchSummary: {
    ambiguous: [
      {
        articleIds: ['a', 'b'],
        articleKey: 'covidence:#9',
        covidenceIds: ['#9'],
        matchTier: 'title_year_first_author',
        referenceIds: [],
        title: 'Twin Study',
      },
    ],
    ambiguousCount: 1,
    baseImportRoute: baseRoute.importRoute,
    countsByTier: {covidence_id: 8336, reference_id: 0, strong_identifier: 10_443, title_year_first_author: 0},
    unmatched: [],
    unmatchedCount: 0,
  },
  routeShares: [baseRoute],
  strongIdentifierRecordCount: 12_462,
  suggestedBaseImportRoute: baseRoute,
}

const cleanups: Array<() => void> = []

afterEach(() => {
  cleanups.splice(0).map((cleanup) => {
    cleanup()
    return cleanup
  })
  document.body.innerHTML = ''
})

const renderPanel = () => {
  const [selected, setSelected] = createSignal<string | null>(baseRoute.importRoute)
  const selections: Array<string | null> = []
  const container = document.createElement('div')
  document.body.appendChild(container)
  const dispose = render(() => {
    return (
      <CovidenceSameReviewPanel
        isAnalyzing={false}
        onSelectBaseImportRoute={(route) => {
          selections.push(route)
          setSelected(route)
        }}
        sameReview={sameReview}
        selectedBaseImportRoute={selected()}
      />
    )
  }, container)
  cleanups.push(dispose)

  return {container, selections}
}

describe('CovidenceSameReviewPanel', () => {
  test('shows the suggested same review as checked with per-tier counts and ambiguous records', () => {
    const {container} = renderPanel()
    const checkbox = container.querySelector<HTMLInputElement>('input[type="checkbox"]')

    expect(checkbox?.checked).toBe(true)
    expect(container.textContent).toContain('Same review as cov 6 | 3')
    expect(container.textContent).toContain('12,400 of 12,462 DOI/PMID records')
    expect(container.textContent).toContain('Covidence #8,336')
    expect(container.textContent).toContain('Ambiguous, not imported1')
    expect(container.textContent).toContain('Twin Study')
  })

  test('clearing the checkbox selects no base route and hides the match counts', () => {
    const {container, selections} = renderPanel()
    const checkbox = container.querySelector<HTMLInputElement>('input[type="checkbox"]')

    checkbox?.click()

    expect(selections).toEqual([null])
    expect(checkbox?.checked).toBe(false)
    expect(container.textContent).not.toContain('Covidence #8,336')
  })
})
