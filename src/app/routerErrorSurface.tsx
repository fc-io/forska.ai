import type {JSX} from 'solid-js'

export const routeErrorSurfaceTestId = 'route-error-surface'

const getRouteErrorMessage = (error: unknown): string => {
  if (error instanceof Error) {
    return error.stack ?? error.message
  }

  return typeof error === 'string' ? error : 'Unknown route error'
}

export const RouterErrorSurface = (props: {error: unknown}): JSX.Element => {
  return (
    <main class="p-6" data-route-error="true" data-testid={routeErrorSurfaceTestId} role="alert">
      <div class="rounded border border-red-300 bg-red-50 p-4 text-red-900">
        <h1 class="text-lg font-semibold">Route render failed</h1>
        <pre class="mt-2 whitespace-pre-wrap text-sm">{getRouteErrorMessage(props.error)}</pre>
      </div>
    </main>
  )
}
