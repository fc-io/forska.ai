import './index.css'

import {QueryClientProvider} from '@tanstack/solid-query'
import {render} from 'solid-js/web'

import {appQueryClient} from './queryClient'
import {Router} from './router'

const rootElement = document.getElementById('root')
if (rootElement && !rootElement.innerHTML) {
  render(() => {
    return (
      <QueryClientProvider client={appQueryClient}>
        <Router />
      </QueryClientProvider>
    )
  }, rootElement)
}
