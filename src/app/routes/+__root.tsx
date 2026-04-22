import {useQuery} from '@tanstack/solid-query'
import {createRootRoute, Outlet} from '@tanstack/solid-router'
import {Match, Switch} from 'solid-js'

import {Navigation} from '../../components/Navigation'
import {duckdbOwnerConnectionsQueryKey, fetchDuckdbOwnerConnections} from '../../utils/duckdbOwnerConnectionsQuery'
import {RouterErrorSurface} from '../routerErrorSurface'
import {env} from '../utils/client-env.ts'

const getBackendUnavailableMessage = (error: unknown) => {
  return error instanceof Error ? error.message : 'Forska could not reach the local backend.'
}

const BackendUnavailableSurface = (props: {error: unknown; onRetry: () => void; retrying: boolean}) => {
  return (
    <main class="min-h-[calc(100vh-4rem)] bg-stone-50 px-6 py-10" role="alert">
      <div class="mx-auto max-w-3xl rounded-3xl border border-amber-200 bg-white p-8 shadow-sm">
        <div class="text-xs font-semibold uppercase tracking-[0.24em] text-amber-700">Backend unavailable</div>
        <h1 class="mt-3 text-3xl font-semibold tracking-tight text-stone-900">Forska cannot reach its local API</h1>
        <p class="mt-3 text-sm leading-6 text-stone-600">
          The UI is running, but the app cannot talk to the backend yet. This can happen after a crash, while the
          backend is still restarting, or if another process is holding the local DuckDB owner lock.
        </p>
        <div class="mt-6 rounded-2xl border border-stone-200 bg-stone-50 p-4 text-sm text-stone-700">
          <div class="font-medium text-stone-900">Backend origin</div>
          <pre class="mt-2 whitespace-pre-wrap break-all font-mono text-xs text-stone-700">{env.VITE_SERVER_API}</pre>
        </div>
        <div class="mt-4 rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-900">
          <div class="font-medium">Last connection error</div>
          <pre class="mt-2 whitespace-pre-wrap break-words text-xs">{getBackendUnavailableMessage(props.error)}</pre>
        </div>
        <div class="mt-6 flex items-center gap-3">
          <button
            class="inline-flex items-center rounded-full bg-stone-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-stone-700 disabled:cursor-wait disabled:bg-stone-400"
            disabled={props.retrying}
            onClick={() => {
              props.onRetry()
            }}
            type="button"
          >
            {props.retrying ? 'Retrying...' : 'Retry connection'}
          </button>
          <span class="text-xs text-stone-500">Keep this window open while the backend recovers.</span>
        </div>
      </div>
    </main>
  )
}

const RootComponent = () => {
  const backendAvailabilityQuery = useQuery(() => {
    return {
      queryKey: duckdbOwnerConnectionsQueryKey,
      queryFn: fetchDuckdbOwnerConnections,
      refetchInterval: 15_000,
      refetchOnReconnect: true,
      refetchOnWindowFocus: true,
      suspense: false,
    }
  })

  return (
    <>
      <Navigation />
      <Switch>
        <Match when={backendAvailabilityQuery.isError}>
          <BackendUnavailableSurface
            error={backendAvailabilityQuery.error}
            onRetry={() => {
              void backendAvailabilityQuery.refetch()
            }}
            retrying={backendAvailabilityQuery.isRefetching}
          />
        </Match>
        <Match when={true}>
          <Outlet />
        </Match>
      </Switch>
    </>
  )
}

export const Route = createRootRoute({component: RootComponent, errorComponent: RouterErrorSurface})
