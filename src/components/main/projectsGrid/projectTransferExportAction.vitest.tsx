// @vitest-environment happy-dom

import {render} from 'solid-js/web'
import {afterEach, beforeEach, expect, test, vi} from 'vitest'

import {ProjectTransferExportAction} from './projectTransferExportAction.tsx'

type MockSessionResponse = {data: unknown; error: unknown; status: number}

const queuedSession = {exportId: 'export-1', expiresAt: '2026-10-10T00:00:00.000Z', progress: null, status: 'queued'}

const mockState = vi.hoisted(() => {
  return {sessionFetchCount: 0, sessionResponses: [] as Array<{data: unknown; error: unknown; status: number}>}
})

vi.mock('@tanstack/solid-query', () => {
  return {
    useMutation: (optionsFactory: () => {onSuccess: (result: unknown) => void}) => {
      return {
        isPending: false,
        mutate: () => {
          optionsFactory().onSuccess({session: queuedSession, status: 'session'})
        },
      }
    },
  }
})

vi.mock('../../../services/apiClient.ts', () => {
  return {
    apiClient: {
      api: {
        projects: {
          export: () => {
            return {
              get: () => {
                const index = Math.min(mockState.sessionFetchCount, mockState.sessionResponses.length - 1)
                mockState.sessionFetchCount += 1
                return Promise.resolve(mockState.sessionResponses[index])
              },
            }
          },
        },
      },
    },
  }
})

const disposers: Array<() => void> = []

const waitForMs = (ms: number) => {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms)
  })
}

const getExportButton = (container: HTMLElement) => {
  return container.querySelector('button')
}

const renderAction = () => {
  const container = document.createElement('div')
  document.body.appendChild(container)
  disposers.push(
    render(() => {
      return <ProjectTransferExportAction projectId="project-1" />
    }, container),
  )

  return container
}

const setSessionResponses = (responses: MockSessionResponse[]) => {
  mockState.sessionResponses = responses
}

beforeEach(() => {
  mockState.sessionFetchCount = 0
  mockState.sessionResponses = []
})

afterEach(() => {
  disposers.splice(0).map((dispose) => {
    return dispose()
  })
  document.body.innerHTML = ''
})

test('stops polling and re-enables export after the server reports a failed export', async () => {
  setSessionResponses([
    {data: null, error: {status: 409, value: {data: null, error: 'Project transfer export failed'}}, status: 409},
  ])
  const container = renderAction()

  getExportButton(container)?.click()
  await waitForMs(0)

  expect(getExportButton(container)?.textContent).toContain('Preparing...')
  expect(getExportButton(container)?.disabled).toBe(true)

  await waitForMs(2_100)

  expect(mockState.sessionFetchCount).toBe(1)
  expect(container.querySelector('[role="alert"]')?.textContent).toBe('Project transfer export failed')
  expect(getExportButton(container)?.textContent).toContain('Export Project')
  expect(getExportButton(container)?.disabled).toBe(false)

  await waitForMs(2_100)

  expect(mockState.sessionFetchCount).toBe(1)
})

test('keeps polling through a transient error and clears it once the status loads', async () => {
  setSessionResponses([
    {data: null, error: {status: 500, value: {data: null, error: 'Temporary failure'}}, status: 500},
    {data: {data: {...queuedSession, status: 'assembling'}, error: null}, error: null, status: 200},
  ])
  const container = renderAction()

  getExportButton(container)?.click()
  await waitForMs(2_100)

  expect(mockState.sessionFetchCount).toBe(1)
  expect(container.querySelector('[role="alert"]')?.textContent).toBe('Temporary failure')

  await waitForMs(2_100)

  expect(mockState.sessionFetchCount).toBe(2)
  expect(container.querySelector('[role="alert"]')).toBeNull()
  expect(getExportButton(container)?.textContent).toContain('Preparing...')
})
