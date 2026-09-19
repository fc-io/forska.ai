// @vitest-environment happy-dom

import {render} from 'solid-js/web'
import {afterEach, describe, expect, test, vi} from 'vitest'

import {CompareProjectExportFilters} from './compareProjectExportFilters.tsx'

const renderFilters = (showArticleCategoryFilter: boolean) => {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const dispose = render(() => {
    return (
      <CompareProjectExportFilters
        articleCategoryFilters={['non_chinese']}
        conflictResolutionFilters={['not-set', 'yes']}
        conflictResolutionFilterOptions={[
          {label: 'Not set', value: 'not-set'},
          {label: 'yes', value: 'yes'},
          {label: 'no', value: 'no'},
          {label: 'maybe', value: 'maybe'},
        ]}
        differenceFilters={[]}
        differenceFilterDisabled={false}
        differenceFilterOptions={[{label: 'Human vs LLM conflict', value: 'human-vs-llm'}]}
        isExportingCsv={false}
        isExportingPdf={false}
        rowFilterOptions={[{label: 'Rows with more than 1 answered prompt', value: 'multiple-answers'}]}
        showArticleCategoryFilter={showArticleCategoryFilter}
        showConflictResolutionFilter={true}
        onArticleCategoryFiltersChange={vi.fn()}
        onConflictResolutionFiltersChange={vi.fn()}
        onDifferenceFiltersChange={vi.fn()}
        onExportCsv={vi.fn()}
        onExportPdf={vi.fn()}
        onRowFiltersChange={vi.fn()}
        rowFilters={[]}
      />
    )
  }, container)

  return {container, dispose}
}

const getTriggerLabels = (container: HTMLElement) => {
  return Array.from(container.querySelectorAll('label')).map((label) => {
    return label.querySelector('span')?.textContent
  })
}

describe('CompareProjectExportFilters', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  test('hides the article category selector when the project has no Chinese articles', () => {
    const {container, dispose} = renderFilters(false)

    try {
      expect(container.textContent).not.toContain('Language')
      expect(container.textContent).not.toContain('Non-Chinese')
      expect(container.querySelector('[aria-label="Language"]')).toBeNull()
    } finally {
      dispose()
    }
  })

  test('shows the article category selector with its selected chips when the project has Chinese articles', () => {
    const {container, dispose} = renderFilters(true)

    try {
      expect(container.textContent).toContain('Language')
      expect(container.querySelector('[aria-label="Language"]')).not.toBeNull()
      expect(container.querySelector('[aria-label="Language"]')?.textContent).toContain('Non-Chinese')
    } finally {
      dispose()
    }
  })

  test('shows conflict-resolution selector between difference and language filters', () => {
    const {container, dispose} = renderFilters(true)

    try {
      expect(getTriggerLabels(container).slice(0, 4)).toEqual([
        'Row filter',
        'Difference filter',
        'Conflict resolutions',
        'Language',
      ])
      expect(container.querySelector('[aria-label="Conflict resolutions"]')?.textContent).toContain('Not set')
      expect(container.querySelector('[aria-label="Conflict resolutions"]')?.textContent).toContain('yes')
      expect(container.querySelector('[aria-label="Row filter"]')?.textContent).toContain('All rows')
    } finally {
      dispose()
    }
  })
})
