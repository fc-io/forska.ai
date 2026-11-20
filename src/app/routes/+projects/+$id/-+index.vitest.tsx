// @vitest-environment happy-dom

import type {Component, JSX, ParentProps} from 'solid-js'
import {splitProps} from 'solid-js'
import {Dynamic} from 'solid-js/web'
import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest'

type MockLinkProps = ParentProps<{class?: string; to: string}>
type MockButtonProps = ParentProps<
  {as?: keyof JSX.IntrinsicElements | Component<Record<string, unknown>>} & Record<string, unknown>
>
type MockQueryResult = {data: unknown; error: unknown; isError: boolean; isLoading: boolean}
type MockQueryStore = {project: MockQueryResult; providerConnections: MockQueryResult}
type MockQueryState = {setStore: (key: keyof MockQueryStore, value: MockQueryResult) => void; store: MockQueryStore}

const mockState = vi.hoisted(() => {
  return {queries: null as MockQueryState | null}
})

const getProjectData = (overrides: {importRoutes?: string[]; name?: string} = {}) => {
  return {
    hasJudgedArticles: false,
    importRouteNamesByRoute: {},
    importRoutes: overrides.importRoutes ?? ['covidence:1'],
    model: {id: 'model-1', name: 'Qwen', provider: 'sglang', modelName: 'qwen'},
    project: {
      id: 'project-1',
      name: overrides.name ?? 'Initial name',
      createdAt: null,
      updatedAt: null,
      description: null,
      dateFrom: null,
      dateTo: null,
      humanJudgmentMode: 'prompt',
      useTitle: true,
      useAbstract: true,
      useFulltext: false,
      useFulltextNoImages: false,
      useMetadata: false,
    },
    prompts: [
      {
        id: 'prompt-1',
        originalText: 'Prompt one',
        transformedText: null,
        promptHeading: null,
        order: 1,
        archived: false,
        type: null,
      },
    ],
  }
}

const getProviderConnectionsData = () => {
  return {
    catalog: [],
    connections: [
      {id: 'provider-1', models: [{id: 'model-1', modelName: 'qwen', provider: 'sglang', remoteModelId: 'qwen'}]},
    ],
    runtime: {activeModelNames: ['other-model'], providerKind: 'sglang', sourceMetadata: null, workerUrls: []},
  }
}

const getLoadedQueryResult = (data: unknown): MockQueryResult => {
  return {data, error: null, isError: false, isLoading: false}
}

const getPendingQueryResult = (): MockQueryResult => {
  return {data: undefined, error: null, isError: false, isLoading: true}
}

vi.mock('@tanstack/solid-query', async () => {
  const {createStore} = await import('solid-js/store')
  const [store, setStore] = createStore<MockQueryStore>({
    project: {data: undefined, error: null, isError: false, isLoading: true},
    providerConnections: {data: undefined, error: null, isError: false, isLoading: true},
  })
  mockState.queries = {
    setStore: (key, value) => {
      setStore(key, value)
    },
    store,
  }
  const getQueryProxy = (key: keyof MockQueryStore) => {
    return {
      get data() {
        return store[key].data
      },
      get error() {
        return store[key].error
      },
      get isError() {
        return store[key].isError
      },
      get isLoading() {
        return store[key].isLoading
      },
    }
  }

  return {
    useQuery: (options: () => {queryKey: unknown[]}) => {
      return options().queryKey[0] === 'provider-connections'
        ? getQueryProxy('providerConnections')
        : getQueryProxy('project')
    },
    useQueryClient: () => {
      return {}
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
        return {
          useParams: () => {
            return () => {
              return {id: 'project-1'}
            }
          },
        }
      }
    },
    useNavigate: () => {
      return vi.fn()
    },
  }
})

vi.mock('../projectAccessGuard', () => {
  return {
    useArchivedProjectRedirect: () => {
      return undefined
    },
    useProjectAccessQuery: () => {
      return {data: {archived: false, humanJudgmentMode: 'prompt'}, error: null, isError: false, isLoading: false}
    },
  }
})

vi.mock('../../../../services/projectsService', () => {
  return {archiveProject: vi.fn(), fetchProjectWithPrompts: vi.fn()}
})

vi.mock('../../+admin/+models/providerConnectionsClient.ts', () => {
  return {fetchProviderConnections: vi.fn()}
})

vi.mock('../../../../components/main/projectDetails/projectDetailsCuratedArticles', () => {
  return {
    ProjectDetailsCuratedArticles: () => {
      return <div data-testid="curated-articles" />
    },
  }
})

vi.mock('../../../../components/main/projectDetails/projectDetailsImportProgress.tsx', () => {
  return {
    ProjectDetailsImportProgress: (props: {importRoutes: string[]}) => {
      return <div data-testid="import-progress">{props.importRoutes.join(',')}</div>
    },
  }
})

vi.mock('../../../../components/main/projectDetails/projectDetailsInformation', () => {
  return {
    ProjectDetailsInformation: (props: {
      importRoutes: string[]
      modelRuntimeNotice?: {message: string} | null
      project: {name: string}
    }) => {
      return (
        <div>
          <div data-testid="project-name">{props.project.name}</div>
          <div data-testid="import-routes">{props.importRoutes.join(',')}</div>
          <div data-testid="runtime-notice">{props.modelRuntimeNotice?.message ?? 'no notice'}</div>
        </div>
      )
    },
  }
})

vi.mock('../../../../components/main/projects/projectDetailsPrompts', () => {
  return {
    ProjectDetailsPrompts: (props: {prompts: unknown[]}) => {
      return <div data-testid="prompt-count">{props.prompts.length}</div>
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

const getQueries = () => {
  if (!mockState.queries) {
    throw new Error('Query mock is not initialized')
  }

  return mockState.queries
}

const renderProjectDetailPage = async () => {
  const {render} = await import('solid-js/web')
  const {ProjectDetail} = await import('./+index.tsx')

  const container = document.createElement('div')
  document.body.appendChild(container)
  const dispose = render(() => {
    return <ProjectDetail />
  }, container)

  await Promise.resolve()

  return {container, dispose}
}

const getText = (container: HTMLElement, testId: string) => {
  return container.querySelector(`[data-testid="${testId}"]`)?.textContent ?? null
}

describe('project detail route', () => {
  beforeEach(async () => {
    document.body.innerHTML = ''
    await import('./+index.tsx')
    getQueries().setStore('project', getLoadedQueryResult(getProjectData()))
    getQueries().setStore('providerConnections', getPendingQueryResult())
  })

  afterEach(() => {
    document.body.innerHTML = ''
  })

  test('renders refreshed project data after the project query refetches', async () => {
    const {container, dispose} = await renderProjectDetailPage()

    try {
      expect(getText(container, 'project-name')).toBe('Initial name')
      expect(getText(container, 'import-routes')).toBe('covidence:1')
      expect(getText(container, 'import-progress')).toBe('covidence:1')
      expect(getText(container, 'prompt-count')).toBe('1')

      getQueries().setStore(
        'project',
        getLoadedQueryResult({
          ...getProjectData({importRoutes: ['covidence:1', 'covidence:2'], name: 'Renamed project'}),
          prompts: [],
        }),
      )
      await Promise.resolve()

      expect(getText(container, 'project-name')).toBe('Renamed project')
      expect(getText(container, 'import-routes')).toBe('covidence:1,covidence:2')
      expect(getText(container, 'import-progress')).toBe('covidence:1,covidence:2')
      expect(getText(container, 'prompt-count')).toBe('0')
    } finally {
      dispose()
      container.remove()
    }
  })

  test('shows the runtime model notice when provider connections load after the project', async () => {
    const {container, dispose} = await renderProjectDetailPage()

    try {
      expect(getText(container, 'runtime-notice')).toBe('no notice')

      getQueries().setStore('providerConnections', getLoadedQueryResult(getProviderConnectionsData()))
      await Promise.resolve()

      expect(getText(container, 'runtime-notice')).toContain('Active SGLang runtime model: other-model.')
    } finally {
      dispose()
      container.remove()
    }
  })
})
