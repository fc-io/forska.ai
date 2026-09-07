// @vitest-environment happy-dom

import {render} from 'solid-js/web'
import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest'

import {CompareProjectResolutionExportSection} from './compareProjectResolutionExportSection.tsx'

const mockServiceState = vi.hoisted(() => {
  return {
    fetchComparisonProjectConflictResolutionExportArtifact: vi.fn(async () => {
      return {
        artifact: {
          exportedAt: '2026-09-07T10:00:00.000Z',
          format: 'forska.comparisonProject.conflictResolution.transfer',
          rows: [],
          source: {
            comparisonProjectDescription: null,
            comparisonProjectId: 'comparison-project-1',
            comparisonProjectName: 'Comparison project',
          },
          version: 1,
        },
        filename: 'conflict-resolutions-comparison-project-1.json',
      }
    }),
  }
})

vi.mock('../../../../../services/comparisonProjectsService.ts', () => {
  return {
    fetchComparisonProjectConflictResolutionExportArtifact:
      mockServiceState.fetchComparisonProjectConflictResolutionExportArtifact,
  }
})

const originalCreateObjectURL = Reflect.get(URL, 'createObjectURL')
const originalRevokeObjectURL = Reflect.get(URL, 'revokeObjectURL')
let anchorClickSpy: ReturnType<typeof vi.spyOn>

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
  mockServiceState.fetchComparisonProjectConflictResolutionExportArtifact.mockClear()
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    value: vi.fn(() => {
      return 'blob:comparison-conflict-resolution-transfer'
    }),
  })
  Object.defineProperty(URL, 'revokeObjectURL', {configurable: true, value: vi.fn()})
  anchorClickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
})

afterEach(() => {
  document.body.innerHTML = ''
  vi.restoreAllMocks()
  Object.defineProperty(URL, 'createObjectURL', {configurable: true, value: originalCreateObjectURL})
  Object.defineProperty(URL, 'revokeObjectURL', {configurable: true, value: originalRevokeObjectURL})
})

describe('CompareProjectResolutionExportSection', () => {
  test('explains the machine-transfer export and applies current filters', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const exportRequest = {
      articleCategoryFilter: 'chinese' as const,
      conflictResolutionFilter: 'yes' as const,
      differenceFilter: 'human-vs-llm' as const,
      rowFilter: 'multiple-answers' as const,
    }
    const dispose = render(() => {
      return (
        <CompareProjectResolutionExportSection
          allowConflictResolution={true}
          comparisonProjectId="comparison-project-1"
          exportRequest={exportRequest}
          resolutionCount={3}
        />
      )
    }, container)

    try {
      expect(container.textContent).toContain('Resolution transfer export')
      expect(container.textContent).toContain('uses the filters above')
      expect(container.textContent).toContain('not intended to be human-usable')

      const exportButton = Array.from(container.querySelectorAll('button')).find((button) => {
        return button.textContent?.trim() === 'Export resolutions (3)'
      })

      exportButton?.click()

      await waitForCondition(() => {
        expect(mockServiceState.fetchComparisonProjectConflictResolutionExportArtifact).toHaveBeenCalledWith(
          'comparison-project-1',
          exportRequest,
        )
        expect(anchorClickSpy).toHaveBeenCalled()
      })
    } finally {
      dispose()
    }
  })

  test('keeps the transfer export disabled when conflict resolution is unavailable', () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const dispose = render(() => {
      return (
        <CompareProjectResolutionExportSection
          allowConflictResolution={false}
          comparisonProjectId="comparison-project-1"
          exportRequest={{
            articleCategoryFilter: 'all',
            conflictResolutionFilter: 'all',
            differenceFilter: 'all',
            rowFilter: 'all',
          }}
        />
      )
    }, container)

    try {
      expect(container.querySelector('button')?.hasAttribute('disabled')).toBe(true)
      expect(container.textContent).toContain('Enable conflict resolution')
    } finally {
      dispose()
    }
  })
})
