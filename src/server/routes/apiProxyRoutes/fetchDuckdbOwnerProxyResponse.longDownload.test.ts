import {afterAll, beforeAll, expect, spyOn, test} from 'bun:test'

import {disableIdleTimeoutForLongDownloadRequest} from './disableIdleTimeoutForLongDownloadRequest.ts'
import {duckdbOwnerProxyLogger} from './duckdbOwnerProxyLogger.ts'
import {getDuckdbOwnerProxyRequestTemplate} from './duckdbOwnerProxyRequestTemplate.ts'
import {getDuckdbOwnerProxyResponse} from './duckdbOwnerProxyResponses.ts'
import type {DuckdbOwnerProxyTimeoutBudgets} from './duckdbOwnerProxyTimeoutMs.ts'
import {fetchDuckdbOwnerProxyRequest} from './fetchDuckdbOwnerProxyResponse.ts'

// Client -> API stand-in -> owner stand-in over real sockets. The owner takes 2 s to send headers (globalThis.Bun.serve flushes
// headers with the first chunk), then streams a chunk every 1.5 s for 7.5 s. Budgets are scaled down: default routes
// 1 s (or 3 s), long-download headers 5 s and a 2 s body idle budget.
const ownerHeadersDelayMs = 2000
const ownerChunkGapMs = 1500
const ownerStallGapMs = 4000
const ownerChunkCount = 6
const fullBody = Array.from({length: ownerChunkCount}, (_, index) => {
  return `chunk-${index};`
}).join('')

const createBudgets = (defaultTimeoutMs: number): DuckdbOwnerProxyTimeoutBudgets => {
  return {
    diagnosticTimeoutMs: 500,
    longDownloadBodyIdleTimeoutMs: 2000,
    longDownloadTimeoutMs: 5000,
    mutationTimeoutMs: defaultTimeoutMs,
    readTimeoutMs: defaultTimeoutMs,
  }
}

type TestServer = ReturnType<typeof globalThis.Bun.serve>
const servers: TestServer[] = []
let ownerUrl = ''
let apiShortUrl = ''
let apiMediumUrl = ''

const startOwnerStandIn = () => {
  return globalThis.Bun.serve({
    async fetch(request) {
      const stall = new URL(request.url).searchParams.get('stall') === '1'
      let index = 0

      await globalThis.Bun.sleep(ownerHeadersDelayMs)

      return new Response(
        new ReadableStream<Uint8Array>({
          async pull(controller) {
            if (index >= ownerChunkCount) {
              controller.close()
              return
            }

            if (index > 0) {
              await globalThis.Bun.sleep(stall && index === 2 ? ownerStallGapMs : ownerChunkGapMs)
            }

            try {
              controller.enqueue(new TextEncoder().encode(`chunk-${index};`))
              index += 1
            } catch {
              // The proxy cancelled the body (timeout). Nothing left to send.
            }
          },
        }),
        {headers: {'content-disposition': 'attachment; filename="cov9.ris"', 'content-type': 'text/plain'}},
      )
    },
    hostname: '127.0.0.1',
    idleTimeout: 30,
    port: 0,
  })
}

const startApiStandIn = (budgets: DuckdbOwnerProxyTimeoutBudgets) => {
  return globalThis.Bun.serve({
    async fetch(request, server) {
      disableIdleTimeoutForLongDownloadRequest(request, server)

      const requestTemplate = await getDuckdbOwnerProxyRequestTemplate(request, server)

      return requestTemplate === null
        ? new Response('route is not owner-proxied', {status: 500})
        : getDuckdbOwnerProxyResponse(await fetchDuckdbOwnerProxyRequest(requestTemplate, ownerUrl, budgets))
    },
    hostname: '127.0.0.1',
    idleTimeout: 30,
    port: 0,
  })
}

const postJson = (baseUrl: string, path: string) => {
  return fetch(`${baseUrl}${path}`, {
    body: JSON.stringify({}),
    headers: {'content-type': 'application/json'},
    method: 'POST',
  })
}

const readBodyOrError = async (response: Response) => {
  return response.text().then(
    (text) => {
      return {ok: true as const, text}
    },
    (error: unknown) => {
      return {error: String(error), ok: false as const}
    },
  )
}

beforeAll(() => {
  spyOn(duckdbOwnerProxyLogger, 'warn').mockImplementation(() => {})
  const owner = startOwnerStandIn()
  const apiShort = startApiStandIn(createBudgets(1000))
  const apiMedium = startApiStandIn(createBudgets(3000))

  servers.push(owner, apiShort, apiMedium)
  ownerUrl = `http://127.0.0.1:${owner.port}`
  apiShortUrl = `http://127.0.0.1:${apiShort.port}`
  apiMediumUrl = `http://127.0.0.1:${apiMedium.port}`
})

afterAll(async () => {
  await Promise.all(
    servers.map((server) => {
      return server.stop(true)
    }),
  )
})

test.concurrent(
  'long-download route: slow headers and a slow healthy stream reach the client in full',
  async () => {
    const startedAtMs = Date.now()
    const response = await postJson(apiShortUrl, '/api/comparison-projects/cov9/covidence-export')

    expect(response.status).toBe(200)
    expect(response.headers.get('content-disposition')).toBe('attachment; filename="cov9.ris"')
    expect(await readBodyOrError(response)).toEqual({ok: true, text: fullBody})
    expect(Date.now() - startedAtMs).toBeGreaterThanOrEqual(
      ownerHeadersDelayMs + (ownerChunkCount - 1) * ownerChunkGapMs - 100,
    )
  },
  30_000,
)

test.concurrent(
  'default route: headers slower than the budget return the 504 JSON error',
  async () => {
    const startedAtMs = Date.now()
    const response = await postJson(apiShortUrl, '/api/comparison-projects/cov9/judgments')

    expect(response.status).toBe(504)
    expect(await response.json()).toEqual({data: null, error: 'DuckDB owner proxy target timed out after 1000 ms'})
    expect(Date.now() - startedAtMs).toBeLessThan(ownerHeadersDelayMs)
  },
  30_000,
)

test.concurrent(
  'default route: unchanged, the total budget still cuts a healthy stream mid-body',
  async () => {
    const response = await postJson(apiMediumUrl, '/api/comparison-projects/cov9/judgments')

    expect(response.status).toBe(200)
    const body = await readBodyOrError(response)

    // Unchanged for default routes: Bun ends the chunked response cleanly, so the client sees a short body.
    expect(body.ok && body.text !== fullBody).toBe(true)
  },
  30_000,
)

test.concurrent(
  'long-download route: a stalled owner stream is cut and the client sees an interrupted download',
  async () => {
    const startedAtMs = Date.now()
    const response = await postJson(apiShortUrl, '/api/comparison-projects/cov9/covidence-export?stall=1')

    expect(response.status).toBe(200)
    const body = await readBodyOrError(response)

    // The socket is dropped without the terminating chunk, so the truncated file can never look complete.
    expect(body).toMatchObject({ok: false})
    expect(Date.now() - startedAtMs).toBeLessThan(ownerHeadersDelayMs + 2 * ownerChunkGapMs + ownerStallGapMs + 6000)
  },
  30_000,
)

// Bun 1.3 does not idle-close a socket while a handler is pending for a request with a body, but it does for GET (or
// a body-less POST): the two GET download routes are the ones the Bun idleTimeout (255 s in serverMain) would cut.
test.concurrent(
  'long-download requests opt out of the Bun server idleTimeout; default requests keep it',
  async () => {
    const slowServer = globalThis.Bun.serve({
      async fetch(request, server) {
        disableIdleTimeoutForLongDownloadRequest(request, server)
        // Bun checks idle sockets on a coarse tick (about 4 s), so sleep well past it.
        await globalThis.Bun.sleep(9000)
        return new Response('late-ok')
      },
      hostname: '127.0.0.1',
      idleTimeout: 1,
      port: 0,
    })

    try {
      const baseUrl = `http://127.0.0.1:${slowServer.port}`
      const [longDownload, defaultRoute] = await Promise.all([
        fetch(`${baseUrl}/__duckdb-owner-rpc/api/projects/p1/export/job-1/download`).then(async (response) => {
          return {status: response.status, text: await response.text()}
        }),
        fetch(`${baseUrl}/api/projects/p1/export/job-1`).then(
          () => {
            return 'responded'
          },
          () => {
            return 'socket closed'
          },
        ),
      ])

      expect(longDownload).toEqual({status: 200, text: 'late-ok'})
      expect(defaultRoute).toBe('socket closed')
    } finally {
      await slowServer.stop(true)
    }
  },
  30_000,
)
