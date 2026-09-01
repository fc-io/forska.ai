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
        articleCategoryFilter="all"
        differenceFilter="all"
        differenceFilterDisabled={false}
        differenceFilterOptions={[{label: 'All rows', value: 'all'}]}
        isExportingCsv={false}
        isExportingPdf={false}
        isSummaryMode={false}
        showArticleCategoryFilter={showArticleCategoryFilter}
        onArticleCategoryFilterChange={vi.fn()}
        onDifferenceFilterChange={vi.fn()}
        onExportCsv={vi.fn()}
        onExportPdf={vi.fn()}
        onRowFilterChange={vi.fn()}
        rowFilter="all"
      />
    )
  }, container)

  return {container, dispose}
}

describe('CompareProjectExportFilters', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  test('hides the article category selector when the project has no Chinese articles', () => {
    const {container, dispose} = renderFilters(false)

    try {
      expect(container.textContent).not.toContain('Article category')
      expect(container.textContent).not.toContain('Chinese articles')
    } finally {
      dispose()
    }
  })

  test('shows the article category selector when the project has Chinese articles', () => {
    const {container, dispose} = renderFilters(true)

    try {
      expect(container.textContent).toContain('Article category')
      expect(container.textContent).toContain('Chinese articles')
    } finally {
      dispose()
    }
  })
})
