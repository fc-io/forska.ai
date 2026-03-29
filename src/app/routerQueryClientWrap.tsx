import {QueryClient, QueryClientProvider} from '@tanstack/solid-query'
import {createComponent} from 'solid-js'
import type {JSX} from 'solid-js'

type RouterWrapProps = {children: JSX.Element}

export const buildRouterQueryClientWrap = (queryClient: QueryClient) => {
  return (props: RouterWrapProps): JSX.Element => {
    return createComponent(QueryClientProvider, {
      client: queryClient,
      get children() {
        return props.children
      },
    })
  }
}
