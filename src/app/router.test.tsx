import {expect, test} from 'bun:test'
import {QueryClient, useQueryClient} from '@tanstack/solid-query'
import {createComponent, createRoot} from 'solid-js'

import {buildRouterQueryClientWrap} from './routerQueryClientWrap'

const QueryClientProbe = () => {
  const queryClient = useQueryClient()

  return queryClient ? 'query-client-ready' : 'query-client-missing'
}

test('buildRouterWrap provides a query client to router children', () => {
  const queryClient = new QueryClient()
  const Wrap = buildRouterQueryClientWrap(queryClient)
  let probeResult = 'query-client-missing'

  createRoot(() => {
    createComponent(Wrap, {
      get children() {
        return createComponent(() => {
          probeResult = QueryClientProbe()

          return null
        }, {})
      },
    })
  })

  expect(probeResult).toBe('query-client-ready')
})
