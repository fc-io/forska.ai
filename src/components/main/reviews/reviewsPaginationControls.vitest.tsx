// @vitest-environment happy-dom

import {createSignal, type JSX, type Setter} from 'solid-js'
import {render} from 'solid-js/web'
import {afterEach, beforeEach, expect, test, vi} from 'vitest'

import {ReviewsPaginationControls} from './reviewsPaginationControls.tsx'

const mockState = vi.hoisted(() => {
  return {mutateCalls: [] as unknown[]}
})

vi.mock('@tanstack/solid-query', () => {
  return {
    createMutation: () => {
      return {
        error: null,
        isError: false,
        isPending: false,
        isSuccess: false,
        mutate: (args: unknown) => {
          mockState.mutateCalls.push(args)
        },
      }
    },
    useQuery: () => {
      return {data: undefined, error: null, isError: false}
    },
    useQueryClient: () => {
      return {
        invalidateQueries: () => {
          return Promise.resolve()
        },
      }
    },
  }
})

vi.mock('../../../services/apiClient.ts', () => {
  return {apiClient: {}}
})

vi.mock('./reviewsWarningsQuery.ts', () => {
  return {
    invalidateReviewsWarningsQueries: () => {
      return Promise.resolve()
    },
  }
})

vi.mock('@ark-ui/solid', () => {
  const PassThrough = (props: {children?: JSX.Element}) => {
    return <div>{props.children}</div>
  }

  return {
    Menu: {Content: PassThrough, Item: PassThrough, Positioner: PassThrough, Root: PassThrough, Trigger: PassThrough},
  }
})

const waitForUpdates = () => {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, 0)
  })
}

const renderControls = () => {
  const [rowSelection, setRowSelection] = createSignal<Record<string, boolean>>({a: true, b: true})
  const [selectAllMatching, setSelectAllMatching] = createSignal(true)
  const [currentPageRowIds, setCurrentPageRowIds] = createSignal(['a', 'b'])
  const container = document.createElement('div')
  document.body.appendChild(container)
  const dispose = render(() => {
    return (
      <ReviewsPaginationControls
        page={1}
        totalPages={null}
        setCurrentPage={
          (() => {
            return 1
          }) as unknown as Setter<number>
        }
        useCursorPagination
        currentPageRowIds={currentPageRowIds()}
        rowSelection={rowSelection}
        setRowSelection={setRowSelection}
        totalMatchingCount={100}
        selectAllMatching={selectAllMatching}
        setSelectAllMatching={setSelectAllMatching}
        sourceProjectId="project-1"
        listType="llm"
        buildAddAllFilterBody={() => {
          return {}
        }}
      />
    )
  }, container)

  return {container, dispose, selectAllMatching, setCurrentPageRowIds, setRowSelection}
}

const clickDownloadPdfs = (container: HTMLElement) => {
  const button = Array.from(container.querySelectorAll('button')).find((candidate) => {
    return candidate.textContent?.includes('Download PDFs for selected')
  })
  button?.click()
}

beforeEach(() => {
  mockState.mutateCalls = []
})

afterEach(() => {
  document.body.innerHTML = ''
})

test('keeps the all-matching selection while every visible row stays selected', async () => {
  const {container, dispose} = renderControls()
  await waitForUpdates()

  expect(container.textContent).toContain('All 100 articles matching filter is selected.')

  clickDownloadPdfs(container)

  expect(mockState.mutateCalls).toEqual([{mode: 'filter'}])
  dispose()
})

test('drops the all-matching selection when a visible row is unchecked', async () => {
  const {container, dispose, selectAllMatching, setRowSelection} = renderControls()
  await waitForUpdates()

  setRowSelection({a: true})
  await waitForUpdates()

  expect(selectAllMatching()).toBe(false)
  expect(container.textContent).not.toContain('All 100 articles matching filter is selected.')

  clickDownloadPdfs(container)

  expect(mockState.mutateCalls).toEqual([{articleIds: ['a'], mode: 'ids'}])
  dispose()
})

test('drops the all-matching selection when more unselected rows are loaded', async () => {
  const {dispose, selectAllMatching, setCurrentPageRowIds} = renderControls()
  await waitForUpdates()

  setCurrentPageRowIds(['a', 'b', 'c'])
  await waitForUpdates()

  expect(selectAllMatching()).toBe(false)
  dispose()
})
