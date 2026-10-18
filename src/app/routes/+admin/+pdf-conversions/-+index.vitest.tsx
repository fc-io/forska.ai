// @vitest-environment happy-dom

import {QueryClient, QueryClientProvider} from '@tanstack/solid-query'
import type {Component, ParentProps} from 'solid-js'
import {lazy} from 'solid-js'
import {render} from 'solid-js/web'
import {afterEach, beforeEach, expect, test, vi} from 'vitest'

const mockedApi = vi.hoisted(() => {
  return {getConversionStats: vi.fn(), postConversionReconvert: vi.fn(), postConversionReset: vi.fn()}
})

vi.mock('@tanstack/solid-router', () => {
  return {
    lazyRouteComponent: (importer: () => Promise<Record<string, Component>>, exportName = 'component') => {
      return lazy(async () => {
        const routeModule = await importer()

        return {default: routeModule[exportName] as Component}
      })
    },
    Link: (props: ParentProps<{class?: string; params?: {id: string}; to: string}>) => {
      return (
        <a class={props.class} href={props.to.replace('$id', props.params?.id ?? '')}>
          {props.children}
        </a>
      )
    },
    createFileRoute: () => {
      return (config: Record<string, unknown>) => {
        return config
      }
    },
  }
})

vi.mock('../../../../services/apiClient.ts', () => {
  return {
    apiClient: {
      api: {
        articles: {
          'conversion-reconvert': {post: mockedApi.postConversionReconvert},
          'conversion-reset': {post: mockedApi.postConversionReset},
          'conversion-stats': {get: mockedApi.getConversionStats},
        },
      },
    },
  }
})

const cronFailure = {
  articleId: null,
  attempts: 3,
  canonicalVersion: null,
  converterKind: null,
  converterVersion: null,
  error: 'MinerU returned HTTP 500',
  id: 'article-cron-failure',
  modelName: 'MinerU 4',
  optionsHash: null,
  providerKind: 'mineru',
  title: 'Cron failure',
  updatedAt: '2026-10-17T10:00:00.000Z',
}

const priorSuccessFailure = {
  ...cronFailure,
  canonicalVersion: 'canonical-v1',
  converterKind: 'mineru',
  converterVersion: '4.0.1',
  id: 'article-prior-success',
  optionsHash: 'options-hash-1',
  title: 'Prior success',
}

const tick = async () => {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0)
  })
}

const waitForCondition = async (assertion: () => void, remaining = 50): Promise<void> => {
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

const renderPage = async () => {
  const {Route} = await import('./+index.tsx')
  const PageComponent = (Route as unknown as {component: Component & {preload: () => Promise<unknown>}}).component
  await PageComponent.preload()
  const queryClient = new QueryClient({defaultOptions: {mutations: {retry: false}, queries: {retry: false}}})
  const container = document.createElement('div')
  document.body.appendChild(container)
  const dispose = render(() => {
    return (
      <QueryClientProvider client={queryClient}>
        <PageComponent />
      </QueryClientProvider>
    )
  }, container)

  return {container, dispose}
}

const getRow = (container: HTMLElement, title: string) => {
  const row = Array.from(container.querySelectorAll('li')).find((item) => {
    return item.textContent?.includes(title)
  })

  if (!row) {
    throw new Error(`Row ${title} not rendered`)
  }

  return row
}

const getReconvertButton = (row: HTMLElement) => {
  const button = Array.from(row.querySelectorAll('button')).find((item) => {
    return item.textContent?.trim() === 'Reconvert'
  })

  if (!button) {
    throw new Error('Reconvert button not rendered')
  }

  return button
}

let disposeRendered: (() => void) | null = null

beforeEach(() => {
  mockedApi.getConversionStats.mockResolvedValue({
    data: {lastFailed: [cronFailure, priorSuccessFailure], totalFailed: 2},
    error: null,
  })
  mockedApi.postConversionReconvert.mockResolvedValue({
    data: {articleId: cronFailure.id, clearedConvertedText: false, success: true},
    error: null,
  })
})

afterEach(() => {
  disposeRendered?.()
  disposeRendered = null
  document.body.innerHTML = ''
  vi.clearAllMocks()
})

test('a failed row shows converter kind, version, options hash and canonical version, with — for missing values', async () => {
  const {container, dispose} = await renderPage()
  disposeRendered = dispose

  await waitForCondition(() => {
    expect(container.textContent).toContain('Prior success')
  })

  const priorSuccessText = getRow(container, 'Prior success').textContent ?? ''
  const cronFailureText = getRow(container, 'Cron failure').textContent ?? ''

  expect(priorSuccessText).toContain('Converter: mineru')
  expect(priorSuccessText).toContain('Version: 4.0.1')
  expect(priorSuccessText).toContain('Options hash: options-hash-1')
  expect(priorSuccessText).toContain('Canonical: canonical-v1')
  expect(cronFailureText).toContain('Converter: —')
  expect(cronFailureText).toContain('Version: —')
  expect(cronFailureText).toContain('Options hash: —')
  expect(cronFailureText).toContain('Canonical: —')
  expect(cronFailureText).toContain('Provider: mineru')
  expect(cronFailureText).toContain('Model: MinerU 4')
})

test('Reconvert posts the article id, refetches the failed list and explains when the cron picks it up', async () => {
  const {container, dispose} = await renderPage()
  disposeRendered = dispose

  await waitForCondition(() => {
    expect(container.textContent).toContain('Cron failure')
  })
  mockedApi.getConversionStats.mockResolvedValue({
    data: {lastFailed: [priorSuccessFailure], totalFailed: 1},
    error: null,
  })

  getReconvertButton(getRow(container, 'Cron failure')).click()

  await waitForCondition(() => {
    expect(container.querySelector('[role="status"]')?.textContent).toContain(
      'only when the article is in a non-archived project with full text on',
    )
    expect(container.textContent).not.toContain('Cron failure')
  })
  expect(mockedApi.postConversionReconvert).toHaveBeenCalledWith({articleId: cronFailure.id})
  expect(mockedApi.getConversionStats).toHaveBeenCalledTimes(2)
})

test('a refused Reconvert shows the server message and keeps the row', async () => {
  mockedApi.postConversionReconvert.mockResolvedValue({
    data: null,
    error: {status: 409, value: {data: null, error: 'Article article-cron-failure has no PDF; fetch or upload one'}},
  })
  const {container, dispose} = await renderPage()
  disposeRendered = dispose

  await waitForCondition(() => {
    expect(container.textContent).toContain('Cron failure')
  })

  getReconvertButton(getRow(container, 'Cron failure')).click()

  await waitForCondition(() => {
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('has no PDF; fetch or upload one')
  })
  expect(container.textContent).toContain('Cron failure')
  expect(mockedApi.getConversionStats).toHaveBeenCalledTimes(1)
})
