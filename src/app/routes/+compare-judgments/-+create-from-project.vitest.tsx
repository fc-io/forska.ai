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

      return queryKey[0] === 'comparison-project-conflict-resolution-import-sources'
        ? mockState.importSourcesQueryResult
        : mockState.sourcesQueryResult
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
    mockState.createComparisonProjectFromProject.mockResolvedValue({id: 'comparison-project-created'})
    mockState.navigate.mockReset()
  })

  afterEach(() => {
    document.body.innerHTML = ''
  })

  test('submits the existing create-from-project payload when no import source is selected', async () => {
    const {container, dispose} = await renderCreateFromProjectPage()

    try {
      expect(container.textContent).toContain('Select a primary project before importing conflict resolutions.')

      await fillSummaryConflictResolutionForm(container)
      expect(container.textContent).toContain('Prior Compare Project')

      await submitForm(container)

      expect(mockState.createComparisonProjectFromProject).toHaveBeenCalledTimes(1)
      expect(getCreateFromProjectInput()).not.toHaveProperty('conflictResolutionImportSourceComparisonProjectIds')
      expect(mockState.navigate).toHaveBeenCalledWith({to: '/compare-judgments'})
    } finally {
      dispose()
      container.remove()
    }
  })

  test('submits selected conflict resolution import sources and keeps server validation errors on the page', async () => {
    mockState.createComparisonProjectFromProject.mockRejectedValueOnce(new Error('Duplicate source DOI import key'))

    const {container, dispose} = await renderCreateFromProjectPage()

    try {
      await fillSummaryConflictResolutionForm(container)
      setChecked(getInputFromLabel(container, 'Prior Compare Project'), true)
      await submitForm(container)

      expect(mockState.createComparisonProjectFromProject).toHaveBeenCalledTimes(1)
      expect(getCreateFromProjectInput().conflictResolutionImportSourceComparisonProjectIds).toEqual([
        'comparison-source-1',
      ])
      expect(container.textContent).toContain('Duplicate source DOI import key')
      expect(mockState.navigate).not.toHaveBeenCalled()
    } finally {
      dispose()
      container.remove()
    }
  })
})
