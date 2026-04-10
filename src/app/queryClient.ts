import {QueryClient} from '@tanstack/solid-query'

export const appQueryClient = new QueryClient({
  defaultOptions: {queries: {retry: 1, refetchOnWindowFocus: false, suspense: false}},
})
