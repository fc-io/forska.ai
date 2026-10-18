// @vitest-environment happy-dom

import type {Component, JSX, ParentProps} from 'solid-js'
import {splitProps} from 'solid-js'
import {Dynamic} from 'solid-js/web'
import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest'

import {getComparisonProjectFullTextStrategyMixError} from '../../../../utils/comparisonProjectFullTextStrategyMix.ts'

type MockLinkProps = ParentProps<{class?: string; to: string}>
type MockButtonProps = ParentProps<
  {as?: keyof JSX.IntrinsicElements | Component<Record<string, unknown>>} & Record<string, unknown>
>

const strategyInputs = {
  canonicalTextVersion: 'canonical-v1',
  chunkPolicy: {maxPromptTokens: 48_000, mode: 'chunked'},
  converterKind: 'mineru',
  converterOptionsHash: 'options-hash',
  converterVersion: '4.0.12',
  figureMode: 'none',
  imageTransportVersion: null,
  promptLayoutVersion: 'layout-v1',
  tokenizerId: 'o200k_base',
}

const buildSource = ({
  figureMode,
  id,
  name,
  strategyId,
}: {
  figureMode: 'native_images' | 'none'
  id: string
  name: string
  strategyId: string
}) => {
  return {
    description: null,
    fullTextStrategyId: strategyId,
    fullTextStrategyInputs: {
      ...strategyInputs,
      figureMode,
      imageTransportVersion: figureMode === 'native_images' ? 'img-v1' : null,
    },
    fullTextStrategyLabel: `mineru 4.0.12 / ${figureMode === 'native_images' ? 'native images' : 'none'} / chunked 48k`,
    humanJudgmentMode: 'summary',
    id,
    importRoutes: [{name: 'Route', route: `route-${id}`}],
    isSummaryCapable: true,
    modelId: `model-${id}`,
    modelName: `Model ${id}`,
    name,
    prompts: [
      {
        criteriaDisposition: 'include',
        criteriaSectionKey: 'population',
        criteriaSectionLabel: 'Population',
        id: `prompt-${id}`,
        order: 0,
        promptHeading: 'Summary prompt',
      },
    ],
    summarySourceProjectId: id,
    useAbstract: true,
    useFulltext: true,
    useFulltextNoImages: false,
    useTitle: true,
  }
}

const mockState = vi.hoisted(() => {
  return {editFormData: null as unknown, navigate: vi.fn(), sources: [] as unknown[], updateComparisonProject: vi.fn()}
})

const getQueryResult = (data: unknown) => {
  return {data, error: null, isError: false, isLoading: false, isSuccess: true}
}

vi.mock('@tanstack/solid-query', () => {
  return {
    useQuery: (options: () => {queryKey: readonly unknown[]}) => {
      const queryKey = options().queryKey

      return queryKey[0] === 'comparison-project-edit'
        ? getQueryResult(mockState.editFormData)
        : queryKey[0] === 'comparison-project-sources'
          ? getQueryResult(mockState.sources)
          : getQueryResult([])
    },
    useQueryClient: () => {
      return {invalidateQueries: vi.fn(async () => {})}
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
      return (options: Record<string, unknown>) => {
        return {
          ...options,
          useParams: () => {
            return () => {
              return {id: 'comparison-edit-1'}
            }
          },
        }
      }
    },
    useNavigate: () => {
      return mockState.navigate
    },
  }
})

vi.mock('../../../../components/ui/button', () => {
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

vi.mock('../../../../services/apiClient', () => {
  return {apiClient: {api: {models: {get: vi.fn()}}}}
})

vi.mock('../../../../services/ensureSelectableModelId.ts', () => {
  return {ensureSelectableModelId: vi.fn()}
})

vi.mock('../../../../services/comparisonProjectsService', () => {
  return {
    fetchComparisonProjectEditFormData: vi.fn(),
    fetchComparisonProjectSources: vi.fn(),
    updateComparisonProject: mockState.updateComparisonProject,
  }
})

const sourceA = buildSource({
  figureMode: 'none',
  id: 'source-a',
  name: 'Alpha Project',
  strategyId: 'fts-aaaaaaaaaaaaaaaa',
})
const sourceB = buildSource({
  figureMode: 'native_images',
  id: 'source-b',
  name: 'Beta Project',
  strategyId: 'fts-bbbbbbbbbbbbbbbb',
})
const sourceC = buildSource({
  figureMode: 'none',
  id: 'source-c',
  name: 'Gamma Project',
  strategyId: 'fts-aaaaaaaaaaaaaaaa',
})

const buildEditFormData = (sourceProjectIds: string[]) => {
  return {
    allowConflictResolution: false,
    availablePrompts: [],
    compareWithHumans: true,
    description: null,
    humanJudgmentMode: 'summary',
    id: 'comparison-edit-1',
    name: 'Comparison',
    promptSelections: [],
    selectedModelIds: [],
    sourceProjectIds,
    sourceProjects: [],
    summarySourceProject: {id: 'source-a', name: 'Alpha Project'},
    summarySourceProjectId: 'source-a',
    updatedAt: '2026-10-17T10:00:00.000Z',
    useAbstract: true,
    useFulltext: true,
    useFulltextNoImages: false,
    useTitle: true,
  }
}

const renderEditPage = async () => {
  const {render} = await import('solid-js/web')
  const {EditComparisonProjectPage: EditPage} = await import('./+edit.tsx')
  const container = document.createElement('div')
  document.body.appendChild(container)
  const dispose = render(() => {
    return <EditPage />
  }, container)

  await Promise.resolve()

  return {container, dispose}
}

const getAdditionalProjectCheckbox = (container: HTMLElement, name: string) => {
  const label = Array.from(container.querySelectorAll('details label')).find((candidate) => {
    return candidate.textContent?.includes(name)
  })
  const input = label?.querySelector('input')

  if (!(input instanceof HTMLInputElement)) {
    throw new Error(`Additional project checkbox not found for ${name}`)
  }

  return input
}

const getSubmitButton = (container: HTMLElement) => {
  return container.querySelector<HTMLButtonElement>('button[type="submit"]')
}

const getStrategyError = (container: HTMLElement) => {
  return container.querySelector('[data-testid="comparison-full-text-strategy-error"]')?.textContent ?? null
}

describe('compare judgments edit route full-text strategy check', () => {
  beforeEach(() => {
    vi.resetModules()
    document.body.innerHTML = ''
    mockState.sources = [sourceA, sourceB, sourceC]
    mockState.updateComparisonProject.mockReset()
    mockState.navigate.mockReset()
  })

  afterEach(() => {
    document.body.innerHTML = ''
  })

  test('adding a project with another strategy shows the server message inline and disables save', async () => {
    mockState.editFormData = buildEditFormData(['source-a'])

    const {container, dispose} = await renderEditPage()

    try {
      expect(getStrategyError(container)).toBeNull()
      expect(getSubmitButton(container)?.disabled).toBe(false)
      expect(container.textContent).toContain('Full text: mineru 4.0.12 / native images / chunked 48k')

      getAdditionalProjectCheckbox(container, 'Beta Project').click()
      await Promise.resolve()

      expect(getStrategyError(container)).toBe(
        getComparisonProjectFullTextStrategyMixError([sourceA, sourceB] as never),
      )
      expect(getStrategyError(container)).toContain('Differing inputs: figureMode, imageTransportVersion')
      expect(getSubmitButton(container)?.disabled).toBe(true)

      getAdditionalProjectCheckbox(container, 'Beta Project').click()
      getAdditionalProjectCheckbox(container, 'Gamma Project').click()
      await Promise.resolve()

      expect(getStrategyError(container)).toBeNull()
      expect(getSubmitButton(container)?.disabled).toBe(false)
    } finally {
      dispose()
      container.remove()
    }
  })

  test('an existing mixed comparison stays editable while its project set is unchanged', async () => {
    mockState.editFormData = buildEditFormData(['source-a', 'source-b'])

    const {container, dispose} = await renderEditPage()

    try {
      expect(getAdditionalProjectCheckbox(container, 'Beta Project').checked).toBe(true)
      expect(getStrategyError(container)).toBeNull()
      expect(getSubmitButton(container)?.disabled).toBe(false)
    } finally {
      dispose()
      container.remove()
    }
  })

  test('a legacy no-images comparison shows the frozen label, has no no-images control and never sends the flag', async () => {
    mockState.editFormData = {
      ...buildEditFormData([]),
      compareWithHumans: false,
      humanJudgmentMode: 'prompt',
      summarySourceProject: null,
      summarySourceProjectId: null,
      useAbstract: false,
      useFulltext: false,
      useFulltextNoImages: true,
      useTitle: false,
    }

    const {container, dispose} = await renderEditPage()

    try {
      expect(container.querySelector('[data-testid="comparison-legacy-full-text-no-images"]')?.textContent).toContain(
        'full text (legacy, no images)',
      )
      expect(container.textContent).not.toContain('Use Full Text (without images)')
      expect(container.textContent).not.toContain('Pick at least one content option.')

      container.querySelector('form')?.dispatchEvent(new Event('submit', {bubbles: true, cancelable: true}))
      await vi.waitFor(() => {
        expect(mockState.updateComparisonProject).toHaveBeenCalledTimes(1)
      })

      const [, input] = mockState.updateComparisonProject.mock.calls[0] as [string, Record<string, unknown>]

      expect(input).toMatchObject({useAbstract: false, useFulltext: false, useTitle: false})
      expect(input).not.toHaveProperty('useFulltextNoImages')
    } finally {
      dispose()
      container.remove()
    }
  })
})
