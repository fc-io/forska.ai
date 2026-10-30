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
          selection={options.selection ?? {columnValues: {}, conflictResolutionValues: []}}
          onSelectionChange={options.onSelectionChange ?? vi.fn()}
        />
      </QueryClientProvider>
    )
  }, container)

  return {container, dispose}
}

const getLabels = (container: HTMLElement) => {
  return Array.from(container.querySelectorAll('label')).map((label) => {
    return label.textContent
  })
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
        "Downloads a Covidence RIS file (full-text review set) with every article that has a selected answer in at least one column, each article once. Import it in Covidence with 'Import into: Full text review'. This export ignores the filters above.",
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
    }
    const expectedBody = {
      columnSelections: [
        {columnId: opusColumn.id, values: ['yes', 'maybe']},
        {columnId: humanColumn.id, values: ['maybe']},
      ],
      conflictResolutionValues: ['yes'],
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

  test('drops conflict resolution values from the request when conflict resolution is off', async () => {
    const {dispose} = renderSection({
      allowConflictResolution: false,
      selection: {columnValues: {}, conflictResolutionValues: ['yes']},
    })

    try {
      await tick()
      expect(mockState.fetchComparisonProjectCovidenceExportCount).not.toHaveBeenCalled()
    } finally {
      dispose()
    }
  })
})
