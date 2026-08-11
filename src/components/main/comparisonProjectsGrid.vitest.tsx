// @vitest-environment happy-dom

import type {ParentProps} from 'solid-js'
import {render} from 'solid-js/web'
import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest'

import type {fetchComparisonProjects} from '../../services/comparisonProjectsService.ts'
import {ComparisonProjectsGrid} from './comparisonProjectsGrid.tsx'

type ComparisonProject = Awaited<ReturnType<typeof fetchComparisonProjects>>[number]
type MockLinkProps = ParentProps<{class?: string; params?: {id?: string}; to: string}>

const mockServiceState = vi.hoisted(() => {
  return {
    archiveComparisonProject: vi.fn(async (_comparisonProjectId: string) => {}),
    fetchComparisonProjectConflictResolutionExportArtifact: vi.fn(async (_comparisonProjectId: string) => {
      return exportResult
    }),
    purgeComparisonProject: vi.fn(async (_comparisonProjectId: string) => {}),
    unarchiveComparisonProject: vi.fn(async (_comparisonProjectId: string) => {}),
  }
})

vi.mock('@tanstack/solid-router', () => {
  return {
    Link: (props: MockLinkProps) => {
      return (
        <a class={props.class} href={props.params?.id ? props.to.replace('$id', props.params.id) : props.to}>
          {props.children}
        </a>
      )
    },
  }
})

vi.mock('../../services/comparisonProjectsService.ts', () => {
  return {
    archiveComparisonProject: mockServiceState.archiveComparisonProject,
    fetchComparisonProjectConflictResolutionExportArtifact:
      mockServiceState.fetchComparisonProjectConflictResolutionExportArtifact,
    purgeComparisonProject: mockServiceState.purgeComparisonProject,
    unarchiveComparisonProject: mockServiceState.unarchiveComparisonProject,
  }
})

const originalCreateObjectURL = Reflect.get(URL, 'createObjectURL')
const originalRevokeObjectURL = Reflect.get(URL, 'revokeObjectURL')
let anchorClickSpy: ReturnType<typeof vi.spyOn>

const transferArtifact = {
  exportedAt: '2026-06-10T12:00:00.000Z',
  format: 'forska.comparisonProject.conflictResolution.transfer',
  rows: [
    {
      externalArticleId: 'external-1',
      identifiers: [],
      resolution: {label: 'Yes', mode: 'summary', value: 'yes'},
      sourceArticleRowId: 'article-1',
      sourceResolutionId: 'resolution-1',
      title: 'Article 1',
    },
  ],
  source: {
    comparisonProjectDescription: null,
    comparisonProjectId: 'comparison-project-1',
    comparisonProjectName: 'Comparison project',
  },
  version: 1,
} as const

let exportResult = {artifact: transferArtifact, filename: 'conflict-resolutions-comparison-project-1.json'}

const getComparisonProject = (overrides: Partial<ComparisonProject> = {}): ComparisonProject => {
  return {
    allowConflictResolution: true,
    archived: false,
    compareWithHumans: true,
    createdAt: new Date('2026-06-10T12:00:00.000Z'),
    description: 'Compare project description',
    humanJudgmentMode: 'summary',
    id: 'comparison-project-1',
    name: 'Comparison project',
    promptCount: 2,
    routeCount: 1,
    summarySourceProjectId: 'project-1',
    useAbstract: true,
    useFulltext: false,
    useFulltextNoImages: false,
    useTitle: true,
    ...overrides,
  }
}

const renderComparisonProjectsGrid = async (
  comparisonProjects: ComparisonProject[],
  props: {isArchived?: boolean; onChange?: () => void} = {},
) => {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const dispose = render(() => {
    return <ComparisonProjectsGrid comparisonProjects={comparisonProjects} {...props} />
  }, container)

  await Promise.resolve()

  return {container, dispose}
}

const getActionLabels = (container: HTMLElement) => {
  return Array.from(container.querySelectorAll('a, button')).map((element) => {
    return element.textContent?.trim() ?? ''
  })
}

const stubConfirm = (confirmed: boolean) => {
  const confirmMock = vi.fn(() => {
    return confirmed
  })
  Object.defineProperty(window, 'confirm', {configurable: true, value: confirmMock})

  return confirmMock
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
  mockServiceState.archiveComparisonProject.mockReset()
  mockServiceState.fetchComparisonProjectConflictResolutionExportArtifact.mockReset()
  mockServiceState.fetchComparisonProjectConflictResolutionExportArtifact.mockResolvedValue(exportResult)
  mockServiceState.purgeComparisonProject.mockReset()
  mockServiceState.unarchiveComparisonProject.mockReset()
  exportResult = {artifact: transferArtifact, filename: 'conflict-resolutions-comparison-project-1.json'}
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
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  Object.defineProperty(URL, 'createObjectURL', {configurable: true, value: originalCreateObjectURL})
  Object.defineProperty(URL, 'revokeObjectURL', {configurable: true, value: originalRevokeObjectURL})
})

describe('ComparisonProjectsGrid resolution export action', () => {
  test('renders Export resolutions after Export data without adding grid import', async () => {
    const {container, dispose} = await renderComparisonProjectsGrid([getComparisonProject()])

    try {
      const labels = getActionLabels(container)
      const exportDataIndex = labels.indexOf('Export data')

      expect(
        container.querySelector('a[href="/compare-judgments/comparison-project-1/export"]')?.textContent?.trim(),
      ).toBe('Export data')
      expect(labels[exportDataIndex + 1]).toBe('Export resolutions')
      expect(labels).not.toContain('Import resolutions')
    } finally {
      dispose()
      container.remove()
    }
  })

  test('omits Export resolutions when conflict resolution is disabled', async () => {
    const {container, dispose} = await renderComparisonProjectsGrid([
      getComparisonProject({allowConflictResolution: false}),
    ])

    try {
      expect(getActionLabels(container)).not.toContain('Export resolutions')
      expect(
        container.querySelector('a[href="/compare-judgments/comparison-project-1/export"]')?.textContent?.trim(),
      ).toBe('Export data')
    } finally {
      dispose()
      container.remove()
    }
  })

  test('downloads the grid conflict-resolution export artifact', async () => {
    const {container, dispose} = await renderComparisonProjectsGrid([getComparisonProject()])

    try {
      const exportButton = Array.from(container.querySelectorAll('button')).find((button) => {
        return button.textContent?.trim() === 'Export resolutions'
      })

      exportButton?.click()

      await waitForCondition(() => {
        expect(mockServiceState.fetchComparisonProjectConflictResolutionExportArtifact).toHaveBeenCalledWith(
          'comparison-project-1',
        )
        expect(anchorClickSpy).toHaveBeenCalled()
        expect(
          container.querySelector('a[href="/compare-judgments/comparison-project-1/export"]')?.textContent?.trim(),
        ).toBe('Export data')
      })
    } finally {
      dispose()
      container.remove()
    }
  })
})

describe('ComparisonProjectsGrid archive actions', () => {
  test('keeps active comparison projects on archive-only actions', async () => {
    const {container, dispose} = await renderComparisonProjectsGrid([getComparisonProject()])

    try {
      const labels = getActionLabels(container)

      expect(labels).toContain('Archive')
      expect(labels).not.toContain('Unarchive')
      expect(labels).not.toContain('Delete permanently')
    } finally {
      dispose()
      container.remove()
    }
  })

  test('shows permanent delete only for archived comparison projects', async () => {
    const {container, dispose} = await renderComparisonProjectsGrid([getComparisonProject({archived: true})], {
      isArchived: true,
    })

    try {
      const labels = getActionLabels(container)

      expect(labels).toContain('Unarchive')
      expect(labels).toContain('Delete permanently')
      expect(labels).not.toContain('Archive')
      expect(labels).not.toContain('Edit')
    } finally {
      dispose()
      container.remove()
    }
  })

  test('confirms and permanently deletes archived comparison projects', async () => {
    const onChange = vi.fn()
    const confirmSpy = stubConfirm(true)
    const {container, dispose} = await renderComparisonProjectsGrid([getComparisonProject({archived: true})], {
      isArchived: true,
      onChange,
    })

    try {
      const deleteButton = Array.from(container.querySelectorAll('button')).find((button) => {
        return button.textContent?.trim() === 'Delete permanently'
      })

      deleteButton?.click()

      await waitForCondition(() => {
        expect(confirmSpy).toHaveBeenCalledWith('Permanently delete "Comparison project"? This cannot be undone.')
        expect(mockServiceState.purgeComparisonProject).toHaveBeenCalledWith('comparison-project-1')
        expect(onChange).toHaveBeenCalled()
      })
    } finally {
      dispose()
      container.remove()
    }
  })

  test('leaves archived comparison projects unchanged when permanent delete is cancelled', async () => {
    const confirmSpy = stubConfirm(false)
    const {container, dispose} = await renderComparisonProjectsGrid([getComparisonProject({archived: true})], {
      isArchived: true,
    })

    try {
      const deleteButton = Array.from(container.querySelectorAll('button')).find((button) => {
        return button.textContent?.trim() === 'Delete permanently'
      })

      deleteButton?.click()

      expect(confirmSpy).toHaveBeenCalled()
      expect(mockServiceState.purgeComparisonProject).not.toHaveBeenCalled()
    } finally {
      dispose()
      container.remove()
    }
  })

  test('shows permanent delete failures inline', async () => {
    mockServiceState.purgeComparisonProject.mockRejectedValue(new Error('Serving cleanup failed'))
    stubConfirm(true)
    const {container, dispose} = await renderComparisonProjectsGrid([getComparisonProject({archived: true})], {
      isArchived: true,
    })

    try {
      const deleteButton = Array.from(container.querySelectorAll('button')).find((button) => {
        return button.textContent?.trim() === 'Delete permanently'
      })

      deleteButton?.click()

      await waitForCondition(() => {
        expect(container.textContent).toContain('Serving cleanup failed')
      })
    } finally {
      dispose()
      container.remove()
    }
  })
})
