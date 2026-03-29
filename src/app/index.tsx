import './index.css'

import {QueryClient} from '@tanstack/solid-query'
import {render} from 'solid-js/web'

import {Router} from './router'

const queryClient = new QueryClient({
  defaultOptions: {queries: {retry: 1, refetchOnWindowFocus: false, suspense: false}},
})

const rootElement = document.getElementById('root')
if (rootElement && !rootElement.innerHTML) {
  render(() => {
    return <Router queryClient={queryClient} />
  }, rootElement)
}
