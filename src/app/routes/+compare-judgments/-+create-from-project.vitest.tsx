// @vitest-environment happy-dom

import type {Component, JSX, ParentProps} from 'solid-js'
import {splitProps} from 'solid-js'
import {Dynamic} from 'solid-js/web'
import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest'

type MockLinkProps = ParentProps<{class?: string; to: string}>
type MockButtonProps = ParentProps<
  {as?: keyof JSX.IntrinsicElements | Component<Record<string, unknown>>} & Record<string, unknown>
>
type CreateFromProjectInput = {conflictResolutionImportSourceComparisonProjectIds?: string[]}

const importWarningCopy =
  'Matching duplicate decisions are imported once. Conflicting or ambiguous decisions are skipped and reported after creation.'

const conflictResolutionImportSummaryWithWarnings = {
  deduped: 0,
  imported: 1,
  matched: 1,
  scanned: 3,
  skipped: 2,
  skippedAmbiguousTarget: 0,
  skippedConflicting: 2,
  skippedInvalidValue: 0,
  skippedNoTargetMatch: 0,
  skippedNoUsableKey: 0,
  skippedNotConflicting: 0,
  warnings: [
    {
      code: 'conflicting-resolution-values',
      matchKey: '10.1000/import-solo',
      matchKeys: ['10.1000/import-solo'],
      matchKind: 'doi',
      matchKinds: ['doi'],
      message: 'Conflicting source resolution values map to target article article-2: yes, no',
      sourceRows: [
        {
          articleId: 'source-conflict-yes',
          articleTitle: 'Conflicting yes title',
          compareProjectId: 'source-comparison-project-1',
          compareProjectName: 'Import warning source',
          externalArticleId: 'source-ext-conflict-yes',
          matchKey: '10.1000/import-solo',
          matchKind: 'doi',
          resolutionAnswer: 'yes',
          sourceResolutionId: 'source-resolution-conflict-yes',
          sourceRowId: 'source-row-conflict-yes',
        },
        {
          articleId: 'source-conflict-no',
          articleTitle: 'Conflicting no title',
          compareProjectId: 'source-comparison-project-1',
          compareProjectName: 'Import warning source',
          externalArticleId: 'source-ext-conflict-no',
          matchKey: '10.1000/import-solo',
          matchKind: 'doi',
          resolutionAnswer: 'no',
          sourceResolutionId: 'source-resolution-conflict-no',
          sourceRowId: 'source-row-conflict-no',
        },
      ],
      targetArticles: [
        {
          articleId: 'article-2',
          articleTitle: 'Article 2',
          doiKeys: ['10.1000/import-solo'],
          externalArticleId: 'target-ext-2',
        },
      ],
      values: ['yes', 'no'],
    },
  ],
}

const mockState = vi.hoisted(() => {
  return {
    createComparisonProjectFromProject: vi.fn(),
    importSourcesQueryResult: {
      data: [
        {
          createdAt: new Date('2026-05-01T00:00:00.000Z'),
          description: 'Prior decisions',
          humanJudgmentMode: 'summary',
          id: 'comparison-source-1',
          name: 'Prior Compare Project',
          resolutionCount: 3,
        },
      ],
      error: null,
      isError: false,
      isLoading: false,
      isSuccess: true,
    },
    importPreviewQueryResult: {
      data: {
        deduped: 1,
        imported: 4,
        matched: 6,
        scanned: 7,
        skipped: 2,
        skippedAmbiguousTarget: 0,
        skippedConflicting: 2,
        skippedInvalidValue: 0,
        skippedNoTargetMatch: 0,
        skippedNoUsableKey: 0,
        skippedNotConflicting: 0,
        warnings: [],
      },
      error: null,
      isError: false,
      isLoading: false,
      isSuccess: true,
    },
    navigate: vi.fn(),
    sourcesQueryResult: {
      data: [
        {
          description: null,
          humanJudgmentMode: 'summary',
          id: 'source-project-1',
          importRoutes: [{name: 'Import route', route: 'import-route-1'}],
          isSummaryCapable: true,
          modelId: 'model-1',
          modelName: 'Model 1',
          name: 'Primary Project',
          prompts: [
            {
              criteriaDisposition: 'include',
              criteriaSectionKey: 'population',
              criteriaSectionLabel: 'Population',
              id: 'prompt-1',
              order: 0,
              promptHeading: 'Summary prompt',
            },
          ],
          summarySourceProjectId: 'source-project-1',
          useAbstract: true,
          useFulltext: false,
          useFulltextNoImages: false,
          useTitle: true,
        },
      ],
      error: null,
      isError: false,
      isLoading: false,
    },
  }
})

vi.mock('@tanstack/solid-query', () => {
  return {
    useQuery: (options: () => {queryKey: readonly unknown[]}) => {
      const queryKey = options().queryKey

      if (queryKey[0] === 'comparison-project-conflict-resolution-import-sources') {
        return mockState.importSourcesQueryResult
      }

      if (queryKey[0] === 'comparison-project-conflict-resolution-import-preview') {
        return mockState.importPreviewQueryResult
      }

      return mockState.sourcesQueryResult
    },
  }
})

vi.mock('@tanstack/solid-router', () => {
  return {
    Link: (props: MockLinkProps) => {
      return (
        <a class={props.class} href={props.to}>
          {props.children}
        </a>
      )
    },
    createFileRoute: () => {
      return () => {
        return {}
      }
    },
    useNavigate: () => {
      return mockState.navigate
    },
  }
})

vi.mock('../../../components/ui/button', () => {
  return {
    Button: (props: MockButtonProps) => {
      const [local, otherProps] = splitProps(props, ['as', 'children'])

      return (
        <Dynamic component={local.as ?? 'button'} {...otherProps}>
          {local.children}
        </Dynamic>
      )
    },
  }
})

vi.mock('../../../services/comparisonProjectsService', () => {
  return {
    createComparisonProjectFromProject: mockState.createComparisonProjectFromProject,
    fetchComparisonProjectConflictResolutionImportPreview: vi.fn(),
    fetchComparisonProjectConflictResolutionImportSources: vi.fn(),
    fetchComparisonProjectSources: vi.fn(),
  }
})

const renderCreateFromProjectPage = async () => {
  const {render} = await import('solid-js/web')
  const {CreateCompareJudgmentsFromProjectPage} = await import('./+create-from-project.tsx')

  const container = document.createElement('div')
  document.body.appendChild(container)
  const dispose = render(() => {
    return <CreateCompareJudgmentsFromProjectPage />
  }, container)

  await Promise.resolve()

  return {container, dispose}
}

const getInputFromLabel = (container: HTMLElement, labelText: string): HTMLInputElement => {
  const label = Array.from(container.querySelectorAll('label')).find((candidateLabel) => {
    return candidateLabel.textContent?.trim().startsWith(labelText)
  })
  const input = label?.querySelector('input')

  if (!(input instanceof HTMLInputElement)) {
    throw new Error(`Input not found for label ${labelText}`)
  }

  return input
}

const getRequiredForm = (container: HTMLElement): HTMLFormElement => {
  const form = container.querySelector('form')

  if (!(form instanceof HTMLFormElement)) {
    throw new Error('Form not found')
  }

  return form
}

const changeInput = (input: HTMLInputElement, value: string) => {
  input.value = value
  input.dispatchEvent(new Event('input', {bubbles: true}))
}

const setChecked = (input: HTMLInputElement, checked: boolean) => {
  if (input.checked !== checked) {
    input.click()
  }
}

const submitForm = async (container: HTMLElement) => {
  getRequiredForm(container).dispatchEvent(new SubmitEvent('submit', {bubbles: true, cancelable: true}))
  await Promise.resolve()
  await Promise.resolve()
}

const getCreateFromProjectInput = (): CreateFromProjectInput => {
  const input = mockState.createComparisonProjectFromProject.mock.calls[0]?.[0] as unknown

  if (typeof input !== 'object' || input === null) {
    throw new Error('Create-from-project input not found')
  }

  return input as CreateFromProjectInput
}

const fillSummaryConflictResolutionForm = async (container: HTMLElement) => {
  const nameInput = container.querySelector('#comparison-project-name')

  if (!(nameInput instanceof HTMLInputElement)) {
    throw new Error('Name input not found')
  }

  changeInput(nameInput, 'Created Compare Project')
  setChecked(getInputFromLabel(container, 'Primary Project'), true)
  await Promise.resolve()
  setChecked(getInputFromLabel(container, 'Summary mode'), true)
  await Promise.resolve()
  setChecked(getInputFromLabel(container, 'Allow conflict resolution'), true)
  await Promise.resolve()
}

describe('compare judgments create-from-project route', () => {
  beforeEach(() => {
    vi.resetModules()
    document.body.innerHTML = ''
    mockState.createComparisonProjectFromProject.mockReset()
    mockState.createComparisonProjectFromProject.mockResolvedValue({data: {id: 'comparison-project-created'}})
    mockState.navigate.mockReset()
  })

  afterEach(() => {
    document.body.innerHTML = ''
  })

  test('shows non-blocking import warning copy', async () => {
    const {container, dispose} = await renderCreateFromProjectPage()

    try {
      expect(container.textContent).toContain(importWarningCopy)
      expect(container.textContent).not.toContain('stop creation and no compare project is created')
    } finally {
      dispose()
      container.remove()
    }
  })

  test('navigates after successful creation without import warnings', async () => {
    const {container, dispose} = await renderCreateFromProjectPage()

    try {
      expect(container.textContent).toContain('Select a primary project before importing conflict resolutions.')

      await fillSummaryConflictResolutionForm(container)
      expect(container.textContent).toContain('Prior Compare Project')

      await submitForm(container)

      expect(mockState.createComparisonProjectFromProject).toHaveBeenCalledTimes(1)
      expect(getCreateFromProjectInput()).not.toHaveProperty('conflictResolutionImportSourceComparisonProjectIds')
      expect(mockState.navigate).toHaveBeenCalledWith({to: '/compare-judgments'})
      expect(container.textContent).not.toContain('Compare project created with import warnings')
    } finally {
      dispose()
      container.remove()
    }
  })

  test('submits selected conflict resolution import sources', async () => {
    const {container, dispose} = await renderCreateFromProjectPage()

    try {
      await fillSummaryConflictResolutionForm(container)
      setChecked(getInputFromLabel(container, 'Prior Compare Project'), true)
      await submitForm(container)

      expect(mockState.createComparisonProjectFromProject).toHaveBeenCalledTimes(1)
      expect(getCreateFromProjectInput().conflictResolutionImportSourceComparisonProjectIds).toEqual([
        'comparison-source-1',
      ])
    } finally {
      dispose()
      container.remove()
    }
  })

  test('previews selected conflict resolution import stats', async () => {
    const {container, dispose} = await renderCreateFromProjectPage()

    try {
      await fillSummaryConflictResolutionForm(container)
      expect(container.textContent).toContain('Select one or more compare projects to preview import stats.')

      setChecked(getInputFromLabel(container, 'Prior Compare Project'), true)
      await Promise.resolve()

      expect(container.textContent).toContain('Import preview')
      expect(container.textContent).toContain('Total selected resolutions')
      expect(container.textContent).toContain('7 resolutions')
      expect(container.textContent).toContain('Duplicate rows')
      expect(container.textContent).toContain('3 resolutions')
      expect(container.textContent).toContain('Conflicting duplicates')
      expect(container.textContent).toContain('2 resolutions')
      expect(container.textContent).toContain('Will import')
      expect(container.textContent).toContain('4 resolutions')
    } finally {
      dispose()
      container.remove()
    }
  })

  test('renders import warnings and stays on the create page after successful creation', async () => {
    mockState.createComparisonProjectFromProject.mockResolvedValueOnce({
      conflictResolutionImportSummary: conflictResolutionImportSummaryWithWarnings,
      data: {id: 'comparison-project-created', name: 'Created Compare Project'},
    })

    const {container, dispose} = await renderCreateFromProjectPage()

    try {
      await fillSummaryConflictResolutionForm(container)
      setChecked(getInputFromLabel(container, 'Prior Compare Project'), true)
      await submitForm(container)

      expect(mockState.navigate).not.toHaveBeenCalled()
      expect(container.textContent).toContain('Compare project created with import warnings')
      expect(container.textContent).toContain('Created Compare Project')
      expect(container.textContent).toContain('comparison-project-created')
      expect(container.textContent).toContain('Skip reason: conflicting-resolution-values')
      expect(container.textContent).toContain('Import warning source')
      expect(container.textContent).toContain('source-comparison-project-1')
      expect(container.textContent).toContain('Conflicting yes title')
      expect(container.textContent).toContain('source-conflict-yes')
      expect(container.textContent).toContain('Article 2')
      expect(container.textContent).toContain('article-2')
      expect(container.textContent).toContain('Resolution answer: yes')
      expect(container.textContent).toContain('Resolution answer: no')
      expect(container.textContent).toContain('Match key: 10.1000/import-solo')
      expect(container.textContent).toContain('Match kind: doi')
      expect(container.textContent).toContain('Open Compare Project')
      expect(container.textContent).toContain('View Compare Projects')
    } finally {
      dispose()
      container.remove()
    }
  })

  test('keeps blocking server validation errors on the form without post-create warnings', async () => {
    mockState.createComparisonProjectFromProject.mockRejectedValueOnce(new Error('Duplicate source DOI import key'))

    const {container, dispose} = await renderCreateFromProjectPage()

    try {
      await fillSummaryConflictResolutionForm(container)
      setChecked(getInputFromLabel(container, 'Prior Compare Project'), true)
      await submitForm(container)

      expect(container.textContent).toContain('Duplicate source DOI import key')
      expect(container.textContent).not.toContain('Compare project created with import warnings')
      expect(mockState.navigate).not.toHaveBeenCalled()
    } finally {
      dispose()
      container.remove()
    }
  })
})
