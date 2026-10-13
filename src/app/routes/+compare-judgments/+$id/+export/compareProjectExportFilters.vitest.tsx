// @vitest-environment happy-dom

import {render} from 'solid-js/web'
import {afterEach, describe, expect, test, vi} from 'vitest'

import {CompareProjectExportFilters} from './compareProjectExportFilters.tsx'

type RenderFiltersOptions = {exportCount?: number | null; showConflictResolutionFilter?: boolean}

const renderFilters = (showArticleCategoryFilter: boolean, options: RenderFiltersOptions = {}) => {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const dispose = render(() => {
    return (
      <CompareProjectExportFilters
        articleCategoryFilters={['non_chinese']}
        exportCount={options.exportCount === undefined ? 1234 : options.exportCount}
        conflictResolutionFilters={['not-set', 'yes']}
        conflictResolutionFilterOptions={[
          {label: 'Not set', value: 'not-set'},
          {label: 'yes', value: 'yes'},
          {label: 'no', value: 'no'},
          {label: 'maybe', value: 'maybe'},
        ]}
        conflictResolutionProvenanceFilters={['outdated']}
        differenceFilters={[]}
        differenceFilterDisabled={false}
        differenceFilterOptions={[{label: 'Human vs LLM conflict', value: 'human-vs-llm'}]}
        isExportingCsv={false}
        isExportingPdf={false}
        rowFilterOptions={[{label: 'Rows with more than 1 answered prompt', value: 'multiple-answers'}]}
        showArticleCategoryFilter={showArticleCategoryFilter}
        showConflictResolutionFilter={options.showConflictResolutionFilter ?? true}
        onArticleCategoryFiltersChange={vi.fn()}
        onConflictResolutionFiltersChange={vi.fn()}
        onConflictResolutionProvenanceFiltersChange={vi.fn()}
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
    return label.textContent
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

  test('has no title search and shows the filtered article count next to the title', () => {
    const {container, dispose} = renderFilters(true)

    try {
      expect(container.querySelector('input[type="text"]')).toBeNull()
      expect(container.textContent).not.toContain('Search title')
      expect(container.querySelector('h2')?.parentElement?.textContent).toBe(
        `Export Filters${(1234).toLocaleString()} articles`,
      )
    } finally {
      dispose()
    }
  })

  test('shows a counting state next to the title while the filtered count is unknown', () => {
    const {container, dispose} = renderFilters(true, {exportCount: null})

    try {
      expect(container.querySelector('h2')?.parentElement?.textContent).toBe('Export FiltersCounting articles…')
    } finally {
      dispose()
    }
  })

  test('shows conflict-resolution selector between difference and language filters', () => {
    const {container, dispose} = renderFilters(true)

    try {
      expect(getTriggerLabels(container).slice(0, 5)).toEqual([
        'Row filter:',
        'Difference filter:',
        'Conflict resolutions:',
        'Resolution prompts:',
        'Language:',
      ])
      expect(container.querySelector('[aria-label="Conflict resolutions"]')?.textContent).toContain('Not set')
      expect(container.querySelector('[aria-label="Conflict resolutions"]')?.textContent).toContain('yes')
      expect(container.querySelector('[aria-label="Row filter"]')?.textContent).toContain('All rows')
    } finally {
      dispose()
    }
  })

  test('shows the resolution prompts selector with its selected chip next to the conflict-resolution selector', () => {
    const {container, dispose} = renderFilters(false)

    try {
      expect(container.querySelector('[aria-label="Resolution prompts"]')?.textContent).toContain('Older prompts')
    } finally {
      dispose()
    }
  })

  test('hides the resolution prompts selector together with the conflict-resolution selector', () => {
    const {container, dispose} = renderFilters(false, {showConflictResolutionFilter: false})

    try {
      expect(container.querySelector('[aria-label="Conflict resolutions"]')).toBeNull()
      expect(container.querySelector('[aria-label="Resolution prompts"]')).toBeNull()
    } finally {
      dispose()
    }
  })
})
