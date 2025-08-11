import './index.css'

import {QueryClient, QueryClientProvider} from '@tanstack/solid-query'
import {render} from 'solid-js/web'

import {Router} from './router'

const queryClient = new QueryClient({
  defaultOptions: {queries: {retry: 1, refetchOnWindowFocus: true}},
})

const rootElement = document.getElementById('root')
if (rootElement && !rootElement.innerHTML) {
  render(() => {
    return (
      <QueryClientProvider client={queryClient}>
        <Router />
      </QueryClientProvider>
    )
  }, rootElement)
}
