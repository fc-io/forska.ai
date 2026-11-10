import {duckdbOwnerPrivateApiPrefix, getApiRouteProxyTimeoutProfile} from '../apiRouteClassification.ts'

type IdleTimeoutServer = {timeout: (request: Request, seconds: number) => void}

/**
 * Both servers listen with Bun's `idleTimeout: 255`, and Bun closes a socket that sends no bytes for that long, even
 * while the handler is still working. Without this, a long-download response whose headers take more than 255 s
 * would be cut regardless of the proxy's 10-minute budget, on the client socket (API process) or on the API to owner
 * socket (owner process). This runs in both processes. The proxy's own headers budget and body idle timer still
 * bound these requests.
 */
export const disableIdleTimeoutForLongDownloadRequest = (request: Request, server: IdleTimeoutServer | null) => {
  const {pathname} = new URL(request.url)
  const publicPathname = pathname.startsWith(`${duckdbOwnerPrivateApiPrefix}/`)
    ? pathname.slice(duckdbOwnerPrivateApiPrefix.length)
    : pathname

  if (
    server === null
    || !publicPathname.startsWith('/api/')
    || getApiRouteProxyTimeoutProfile(publicPathname, request.method) !== 'long-download'
  ) {
    return false
  }

  server.timeout(request, 0)
  return true
}
