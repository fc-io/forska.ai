// @vitest-environment happy-dom

import {QueryClient, QueryClientProvider} from '@tanstack/solid-query'
import {render} from 'solid-js/web'
import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest'

import type {ComparisonProjectJudgmentsColumn} from '../../../../../services/comparisonProjectsService.ts'
import {CompareProjectCovidenceExportSection} from './compareProjectCovidenceExportSection.tsx'
import type {CompareProjectCovidenceExportUrlSelection} from './compareProjectCovidenceExportUrlState.ts'

const mockState = vi.hoisted(() => {
  return {
    downloadFileFromPost: vi.fn(async () => {}),
    fetchComparisonProjectCovidenceExportCount: vi.fn(async () => {
      return {totalCount: 3}
    }),
  }
})

vi.mock('../../../../../services/comparisonProjectsService.ts', () => {
  return {
    fetchComparisonProjectCovidenceExportCount: mockState.fetchComparisonProjectCovidenceExportCount,
    getComparisonProjectCovidenceExportPath: (comparisonProjectId: string) => {
      return `/api/comparison-projects/${comparisonProjectId}/covidence-export`
    },
  }
})

vi.mock('../../../../utils/downloadCsv.ts', () => {
  return {downloadFileFromPost: mockState.downloadFileFromPost}
})

const humanColumn: ComparisonProjectJudgmentsColumn = {
  contentLabel: null,
  id: 'human:summary',
  kind: 'human',
  modelId: null,
  modelLabel: 'Human',
  promptId: 'summary',
  promptLabel: 'Summary',
  sourceProjectId: null,
  sourceProjectName: null,
}

const getLlmColumn = (modelId: string, modelLabel: string): ComparisonProjectJudgmentsColumn => {
  return {
    contentLabel: 'Title + Abstract',
    id: `llm:source-a:${modelId}:1100:summary`,
    kind: 'llm',
    modelId,
    modelLabel,
    promptId: 'summary',
    promptLabel: 'Summary',
    sourceProjectId: 'source-a',
    sourceProjectName: 'Source A',
  }
}

const gptColumn = getLlmColumn('model-gpt', 'GPT 5.5')
const opusColumn = getLlmColumn('model-opus', 'Opus 5.5')

type RenderOptions = {
  allowConflictResolution?: boolean
  humanJudgmentMode?: 'prompt' | 'summary'
  onSelectionChange?: (selection: CompareProjectCovidenceExportUrlSelection) => void
  selection?: CompareProjectCovidenceExportUrlSelection
}

const renderSection = (options: RenderOptions = {}) => {
  const queryClient = new QueryClient({defaultOptions: {mutations: {retry: false}, queries: {retry: false}}})
  const container = document.createElement('div')
  document.body.appendChild(container)
  const dispose = render(() => {
    return (
      <QueryClientProvider client={queryClient}>
        <CompareProjectCovidenceExportSection
          comparisonProject={{
            activeGeneration: 4,
            allowConflictResolution: options.allowConflictResolution ?? true,
            columns: [humanColumn, gptColumn, opusColumn],
            compareWithHumans: true,
            humanJudgmentMode: options.humanJudgmentMode ?? 'summary',
            prompts: [
              {
                criteriaDisposition: 'include',
                criteriaSectionKey: 'population',
                criteriaSectionLabel: 'Population',
                id: 'prompt-population',
                order: 0,
                promptHeading: 'Population',
                promptLabel: 'Population',
                type: "'yes' | 'no' | 'maybe'",
              },
            ],
          }}
          comparisonProjectId="comparison-project-1"
          selection={options.selection ?? {columnValues: {}, conflictResolutionValues: [], invert: false}}
          onSelectionChange={options.onSelectionChange ?? vi.fn()}
        />
      </QueryClientProvider>
    )
  }, container)

  return {container, dispose}
}

const getLabels = (container: HTMLElement) => {
  return Array.from(container.querySelectorAll('label'))
    .filter((label) => {
      return label.querySelector('input[type="checkbox"]') === null
    })
    .map((label) => {
      return label.textContent
    })
}

const getInvertCheckbox = (container: HTMLElement) => {
  return container.querySelector<HTMLInputElement>('input[type="checkbox"]')
}

const getExportButton = (container: HTMLElement) => {
  return Array.from(container.querySelectorAll('button')).find((button) => {
    return button.textContent?.includes('Covidence')
  })
}

const tick = () => {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, 0)
  })
}

const waitForCondition = async (assertion: () => void, remaining = 30): Promise<void> => {
  try {
    assertion()
  } catch (error) {
    if (remaining <= 0) {
      throw error
    }

    await tick()
    return waitForCondition(assertion, remaining - 1)
  }
}

beforeEach(() => {
  document.body.innerHTML = ''
  mockState.downloadFileFromPost.mockClear()
  mockState.fetchComparisonProjectCovidenceExportCount.mockClear()
})

afterEach(() => {
  document.body.innerHTML = ''
})

describe('CompareProjectCovidenceExportSection', () => {
  test('renders nothing for a prompt-mode compare project', () => {
    const {container, dispose} = renderSection({humanJudgmentMode: 'prompt'})

    try {
      expect(container.textContent).toBe('')
      expect(container.querySelector('section')).toBeNull()
      expect(mockState.fetchComparisonProjectCovidenceExportCount).not.toHaveBeenCalled()
    } finally {
      dispose()
    }
  })

  test('shows one select per column in column order plus the conflict resolution select', () => {
    const {container, dispose} = renderSection()

    try {
      expect(container.querySelector('h2')?.textContent).toBe('Export to Covidence')
      expect(container.querySelector('section p')?.textContent?.replace(/\s+/gu, ' ').trim()).toBe(
        `Downloads a Covidence RIS file (full-text review set) with every article that has a selected answer in at least one column, each article once. Import it in Covidence with 'Import into: Full text review'. The inverted export (every article that does not match the selection) is meant for 'Import into: Excluded' / 'Irrelevant', the normal one for 'Full text review'. Covidence imports at most ${(15_000).toLocaleString()} references per file, so a larger selection downloads as a ZIP of RIS files with at most ${(15_000).toLocaleString()} articles each. This export ignores the filters above.`,
      )
      expect(getLabels(container)).toEqual([
        'Summary - LLM - GPT 5.5 - Title + Abstract:',
        'Summary - LLM - Opus 5.5 - Title + Abstract:',
        'Summary - Human answer:',
        'Conflict resolution:',
      ])
      Array.from(container.querySelectorAll('label')).forEach((label) => {
        expect(label.classList.contains('truncate')).toBe(false)
        expect(label.getAttribute('title')).toBeNull()
      })
      expect(container.querySelector('[aria-label="Summary - Human answer"]')?.textContent).toContain('None')
      expect(container.querySelector('[aria-label="Conflict resolution"]')).not.toBeNull()
      expect(getInvertCheckbox(container)?.closest('label')?.textContent?.trim()).toBe(
        'Invert: export the articles that do not match the selection above',
      )
      expect(getInvertCheckbox(container)?.checked).toBe(false)
    } finally {
      dispose()
    }
  })

  test('leaves out the conflict resolution select when conflict resolution is off', () => {
    const {container, dispose} = renderSection({allowConflictResolution: false})

    try {
      expect(getLabels(container)).toHaveLength(3)
      expect(container.querySelector('[aria-label="Conflict resolution"]')).toBeNull()
    } finally {
      dispose()
    }
  })

  test('disables the export button and says why when nothing is selected', () => {
    const {container, dispose} = renderSection()

    try {
      expect(getExportButton(container)?.textContent).toBe('Export 0 articles to Covidence')
      expect(getExportButton(container)?.hasAttribute('disabled')).toBe(true)
      expect(container.textContent).toContain('Nothing is selected, so there is nothing to export.')
      expect(mockState.fetchComparisonProjectCovidenceExportCount).not.toHaveBeenCalled()
    } finally {
      dispose()
    }
  })

  test('counts and exports the selected answers as one request body', async () => {
    const selection = {
      columnValues: {
        [humanColumn.id]: ['maybe'],
        [opusColumn.id]: ['yes', 'maybe'],
        'llm:retired-model:1100:summary': ['no'],
      },
      conflictResolutionValues: ['yes'],
      invert: false,
    }
    const expectedBody = {
      columnSelections: [
        {columnId: opusColumn.id, values: ['yes', 'maybe']},
        {columnId: humanColumn.id, values: ['maybe']},
      ],
      conflictResolutionValues: ['yes'],
      invertSelection: false,
    }
    const {container, dispose} = renderSection({selection})

    try {
      expect(container.querySelector(`[aria-label="${getLabels(container)[1]?.slice(0, -1)}"]`)?.textContent).toContain(
        'yes',
      )

      await waitForCondition(() => {
        expect(mockState.fetchComparisonProjectCovidenceExportCount).toHaveBeenCalledWith(
          'comparison-project-1',
          expectedBody,
        )
        expect(getExportButton(container)?.textContent).toBe('Export 3 articles to Covidence')
      })

      getExportButton(container)?.click()

      await waitForCondition(() => {
        expect(mockState.downloadFileFromPost).toHaveBeenCalledWith({
          body: expectedBody,
          errorMessage: 'Covidence export failed',
          fallbackFilename: 'covidence-export-comparison-project-1.ris',
          path: '/api/comparison-projects/comparison-project-1/covidence-export',
        })
      })
    } finally {
      dispose()
    }
  })

  test('says the download is a ZIP of RIS files when the count is over the Covidence per-file limit', async () => {
    mockState.fetchComparisonProjectCovidenceExportCount.mockResolvedValueOnce({totalCount: 30_001})
    const {container, dispose} = renderSection({
      selection: {columnValues: {[humanColumn.id]: ['no']}, conflictResolutionValues: [], invert: false},
    })

    try {
      await waitForCondition(() => {
        expect(getExportButton(container)?.textContent).toBe(
          `Export ${(30_001).toLocaleString()} articles to Covidence`,
        )
        expect(getExportButton(container)?.hasAttribute('disabled')).toBe(false)
        expect(container.textContent).toContain(
          `Covidence imports at most ${(15_000).toLocaleString()} references per file, so the download is a ZIP with 3 RIS files. Import each file separately.`,
        )
      })

      getExportButton(container)?.click()

      await waitForCondition(() => {
        expect(mockState.downloadFileFromPost).toHaveBeenCalledWith({
          body: {
            columnSelections: [{columnId: humanColumn.id, values: ['no']}],
            conflictResolutionValues: [],
            invertSelection: false,
          },
          errorMessage: 'Covidence export failed',
          fallbackFilename: 'covidence-export-comparison-project-1.ris',
          path: '/api/comparison-projects/comparison-project-1/covidence-export',
        })
      })
    } finally {
      dispose()
    }
  })

  test('drops conflict resolution values from the request when conflict resolution is off', async () => {
    const {dispose} = renderSection({
      allowConflictResolution: false,
      selection: {columnValues: {}, conflictResolutionValues: ['yes'], invert: false},
    })

    try {
      await tick()
      expect(mockState.fetchComparisonProjectCovidenceExportCount).not.toHaveBeenCalled()
    } finally {
      dispose()
    }
  })

  test('the invert checkbox toggles the invert flag through the selection callback', () => {
    const onSelectionChange = vi.fn()
    const selection = {columnValues: {[humanColumn.id]: ['yes', 'maybe']}, conflictResolutionValues: [], invert: false}
    const unchecked = renderSection({onSelectionChange, selection})

    try {
      getInvertCheckbox(unchecked.container)?.click()
      expect(onSelectionChange).toHaveBeenLastCalledWith({...selection, invert: true})
    } finally {
      unchecked.dispose()
    }

    const checked = renderSection({onSelectionChange, selection: {...selection, invert: true}})

    try {
      expect(getInvertCheckbox(checked.container)?.checked).toBe(true)
      getInvertCheckbox(checked.container)?.click()
      expect(onSelectionChange).toHaveBeenLastCalledWith({...selection, invert: false})
      expect(onSelectionChange).toHaveBeenCalledTimes(2)
    } finally {
      checked.dispose()
    }
  })

  test('counts and exports the inverted selection and says how many articles do not match', async () => {
    const selection = {columnValues: {[humanColumn.id]: ['yes', 'maybe']}, conflictResolutionValues: [], invert: true}
    const expectedBody = {
      columnSelections: [{columnId: humanColumn.id, values: ['yes', 'maybe']}],
      conflictResolutionValues: [],
      invertSelection: true,
    }
    const {container, dispose} = renderSection({selection})

    try {
      await waitForCondition(() => {
        expect(mockState.fetchComparisonProjectCovidenceExportCount).toHaveBeenCalledWith(
          'comparison-project-1',
          expectedBody,
        )
        expect(getExportButton(container)?.textContent).toBe('Export 3 articles to Covidence')
        expect(container.textContent).toContain('Inverted: 3 articles do not match the selection above.')
      })

      getExportButton(container)?.click()

      await waitForCondition(() => {
        expect(mockState.downloadFileFromPost).toHaveBeenCalledWith({
          body: expectedBody,
          errorMessage: 'Covidence export failed',
          fallbackFilename: 'covidence-export-comparison-project-1.ris',
          path: '/api/comparison-projects/comparison-project-1/covidence-export',
        })
      })
    } finally {
      dispose()
    }
  })

  test('a failed export shows the error from the server, not only the generic message', async () => {
    mockState.downloadFileFromPost.mockRejectedValueOnce(
      new Error('DuckDB owner proxy target timed out after 600000 ms'),
    )
    const {container, dispose} = renderSection({
      selection: {columnValues: {[humanColumn.id]: ['yes']}, conflictResolutionValues: [], invert: false},
    })

    try {
      await waitForCondition(() => {
        expect(getExportButton(container)?.textContent).toBe('Export 3 articles to Covidence')
      })

      getExportButton(container)?.click()

      await waitForCondition(() => {
        expect(mockState.downloadFileFromPost).toHaveBeenCalledWith(
          expect.objectContaining({errorMessage: 'Covidence export failed'}),
        )
        expect(container.textContent).toContain('DuckDB owner proxy target timed out after 600000 ms')
      })
      expect(container.textContent).not.toContain('Covidence export failed')
    } finally {
      dispose()
    }
  })

  test('an inverted empty selection still has nothing to export', async () => {
    const {container, dispose} = renderSection({
      selection: {columnValues: {}, conflictResolutionValues: [], invert: true},
    })

    try {
      await tick()
      expect(getExportButton(container)?.textContent).toBe('Export 0 articles to Covidence')
      expect(getExportButton(container)?.hasAttribute('disabled')).toBe(true)
      expect(container.textContent).toContain('Nothing is selected, so there is nothing to export.')
      expect(mockState.fetchComparisonProjectCovidenceExportCount).not.toHaveBeenCalled()
    } finally {
      dispose()
    }
  })
})
