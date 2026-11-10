import {afterEach, beforeEach, expect, type Mock, mock, spyOn, test} from 'bun:test'

import {duckdbOwnerProxyLogger} from './duckdbOwnerProxyLogger.ts'
import type {DuckdbOwnerProxyRequestTemplate} from './duckdbOwnerProxyRequestTemplate.ts'
import type {DuckdbOwnerProxyTimeoutBudgets} from './duckdbOwnerProxyTimeoutMs.ts'
import {fetchDuckdbOwnerProxyRequest} from './fetchDuckdbOwnerProxyResponse.ts'

// Real budgets scaled down 50x: 60 s -> 1.2 s, 10 min -> 12 s. Test names use the real-world durations.
const scale = 50
const scaled = (realMs: number) => {
  return realMs / scale
}
const scaledBudgets: DuckdbOwnerProxyTimeoutBudgets = {
  diagnosticTimeoutMs: scaled(3000),
  longDownloadBodyIdleTimeoutMs: scaled(60_000),
  longDownloadTimeoutMs: scaled(600_000),
  mutationTimeoutMs: scaled(60_000),
  readTimeoutMs: scaled(60_000),
}

const covidenceExportTemplate: DuckdbOwnerProxyRequestTemplate = {
  body: new TextEncoder().encode('{}').buffer,
  classification: 'owner-dependent',
  failClosedWithoutDuckdbOwner: true,
  headers: new Headers({'content-type': 'application/json'}),
  method: 'POST',
  pathname: '/__duckdb-owner-rpc/api/comparison-projects/cov9/covidence-export',
  search: '',
}
const judgmentsTemplate: DuckdbOwnerProxyRequestTemplate = {
  ...covidenceExportTemplate,
  pathname: '/__duckdb-owner-rpc/api/comparison-projects/cov9/judgments',
}

type OwnerScript = {chunkGapsMs: number[]; headersDelayMs: number}

/** Stands in for fetch() to the owner: honours the abort signal before headers and while the body streams. */
const createFakeOwnerFetch = (script: OwnerScript) => {
  return async (input: Request | string | URL) => {
    const signal = input instanceof Request ? input.signal : null

    return new Promise<Response>((resolve, reject) => {
      const rejectOnAbort = () => {
        clearTimeout(headersTimer)
        reject(signal?.reason ?? new Error('aborted'))
      }
      const headersTimer = setTimeout(() => {
        signal?.removeEventListener('abort', rejectOnAbort)
        const chunkTimers: ReturnType<typeof setTimeout>[] = []
        const body = new ReadableStream<Uint8Array>({
          cancel() {
            chunkTimers.forEach(clearTimeout)
          },
          start(controller) {
            const errorOnAbort = () => {
              chunkTimers.forEach(clearTimeout)
              controller.error(signal?.reason ?? new Error('aborted'))
            }
            let atMs = 0

            signal?.addEventListener('abort', errorOnAbort, {once: true})
            script.chunkGapsMs.forEach((gapMs, index) => {
              atMs += gapMs
              chunkTimers.push(
                setTimeout(() => {
                  controller.enqueue(new TextEncoder().encode(`chunk-${index};`))
                }, atMs),
              )
            })
            chunkTimers.push(
              setTimeout(() => {
                signal?.removeEventListener('abort', errorOnAbort)
                controller.close()
              }, atMs + 1),
            )
          },
        })

        resolve(new Response(body, {headers: {'content-disposition': 'attachment; filename="x.ris"'}, status: 200}))
      }, script.headersDelayMs)

      signal?.addEventListener('abort', rejectOnAbort, {once: true})
    })
  }
}

const expectedBody = (chunkCount: number) => {
  return Array.from({length: chunkCount}, (_, index) => {
    return `chunk-${index};`
  }).join('')
}

const getRejectionMessage = async (promise: Promise<unknown>) => {
  return promise.then(
    () => {
      return null
    },
    (error: unknown) => {
      return error instanceof Error ? error.message : String(error)
    },
  )
}

const getBody = (response: Response) => {
  if (response.body === null) {
    throw new Error('Expected a response body')
  }

  return response.body
}

const originalFetch = globalThis.fetch
let warnSpy: Mock<typeof duckdbOwnerProxyLogger.warn>

const useFakeOwner = (script: OwnerScript) => {
  globalThis.fetch = createFakeOwnerFetch(script) as unknown as typeof fetch
}

const getTimeoutWarnings = () => {
  return warnSpy.mock.calls
    .filter(([key]) => {
      return key.startsWith('api-proxy:duckdb-owner-timeout:')
    })
    .map(([key, , attrs]) => {
      return {attrs: attrs as Record<string, unknown>, key}
    })
}

beforeEach(() => {
  warnSpy = spyOn(duckdbOwnerProxyLogger, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  globalThis.fetch = originalFetch
  warnSpy.mockRestore()
})

test('long-download: headers after 70 s are accepted (10-minute headers budget)', async () => {
  useFakeOwner({chunkGapsMs: [scaled(1000), scaled(1000)], headersDelayMs: scaled(70_000)})

  const response = await fetchDuckdbOwnerProxyRequest(covidenceExportTemplate, 'http://owner.test', scaledBudgets)

  expect(response.status).toBe(200)
  expect(response.headers.get('content-disposition')).toBe('attachment; filename="x.ris"')
  expect(await response.text()).toBe(expectedBody(2))
  expect(getTimeoutWarnings()).toEqual([])
}, 10_000)

test('long-download: chunks every 10 s for 3 minutes stream to the end (no total-body cap)', async () => {
  const chunkCount = 18
  useFakeOwner({
    chunkGapsMs: Array.from({length: chunkCount}, () => {
      return scaled(10_000)
    }),
    headersDelayMs: 0,
  })
  const startedAtMs = Date.now()

  const response = await fetchDuckdbOwnerProxyRequest(covidenceExportTemplate, 'http://owner.test', scaledBudgets)

  expect(await response.text()).toBe(expectedBody(chunkCount))
  expect(Date.now() - startedAtMs).toBeGreaterThanOrEqual(scaled(180_000) - 50)
  expect(getTimeoutWarnings()).toEqual([])
}, 10_000)

test('long-download: a 61 s gap mid-stream aborts the body with a stall error and a warning', async () => {
  useFakeOwner({chunkGapsMs: [scaled(1000), scaled(1000), scaled(61_000), scaled(1000)], headersDelayMs: 0})

  const response = await fetchDuckdbOwnerProxyRequest(covidenceExportTemplate, 'http://owner.test', scaledBudgets)

  expect(response.status).toBe(200)
  expect(await getRejectionMessage(response.text())).toBe(
    `DuckDB owner proxy response stalled: no body data for ${scaled(60_000)} ms`,
  )

  const warnings = getTimeoutWarnings()
  expect(warnings).toHaveLength(1)
  expect(warnings[0]?.key).toBe('api-proxy:duckdb-owner-timeout:body-idle')
  expect(warnings[0]?.attrs).toMatchObject({
    method: 'POST',
    phase: 'body-idle',
    publicPathname: '/api/comparison-projects/cov9/covidence-export',
    timeoutMs: scaled(60_000),
  })
  expect(warnings[0]?.attrs.elapsedMs).toBeGreaterThanOrEqual(scaled(62_000) - 20)
}, 10_000)

test('long-download: a slow client is not an owner stall (idle clock runs only while waiting on the owner)', async () => {
  const idleBudgetMs = 100
  useFakeOwner({chunkGapsMs: [0, 0, 0], headersDelayMs: 0})

  const response = await fetchDuckdbOwnerProxyRequest(covidenceExportTemplate, 'http://owner.test', {
    ...scaledBudgets,
    longDownloadBodyIdleTimeoutMs: idleBudgetMs,
  })
  const reader = getBody(response).getReader()
  const chunks: string[] = []

  for (;;) {
    await globalThis.Bun.sleep(idleBudgetMs * 2.5)
    const result = await reader.read()

    if (result.done) {
      break
    }

    chunks.push(new TextDecoder().decode(result.value))
  }

  expect(chunks.join('')).toBe(expectedBody(3))
  expect(getTimeoutWarnings()).toEqual([])
}, 10_000)

test('default route: unchanged, the 60 s timer still covers the body and aborts it mid-stream', async () => {
  useFakeOwner({
    chunkGapsMs: Array.from({length: 18}, () => {
      return scaled(10_000)
    }),
    headersDelayMs: 0,
  })
  const startedAtMs = Date.now()

  const response = await fetchDuckdbOwnerProxyRequest(judgmentsTemplate, 'http://owner.test', scaledBudgets)

  expect(response.status).toBe(200)
  expect(await getRejectionMessage(response.text())).not.toBeNull()

  const warnings = getTimeoutWarnings()
  expect(
    warnings.map(({key}) => {
      return key
    }),
  ).toEqual(['api-proxy:duckdb-owner-timeout:body'])
  expect(warnings[0]?.attrs.elapsedMs).toBeGreaterThanOrEqual(scaled(60_000) - 20)
  expect(warnings[0]?.attrs.elapsedMs).toBeLessThan(scaled(70_000))
  expect(Date.now() - startedAtMs).toBeLessThan(scaled(180_000))
}, 10_000)

test('default route: unchanged, headers after 70 s return the 60 s 504 and log a headers timeout', async () => {
  useFakeOwner({chunkGapsMs: [0], headersDelayMs: scaled(70_000)})

  const response = await fetchDuckdbOwnerProxyRequest(judgmentsTemplate, 'http://owner.test', scaledBudgets)

  expect(response.status).toBe(504)
  expect(await response.json()).toEqual({
    data: null,
    error: `DuckDB owner proxy target timed out after ${scaled(60_000)} ms`,
  })
  const warnings = getTimeoutWarnings()
  expect(
    warnings.map(({key}) => {
      return key
    }),
  ).toEqual(['api-proxy:duckdb-owner-timeout:headers'])
  expect(warnings[0]?.attrs).toMatchObject({
    pathname: '/__duckdb-owner-rpc/api/comparison-projects/cov9/judgments',
    phase: 'headers',
    timeoutMs: scaled(60_000),
  })
  expect(warnings[0]?.attrs.elapsedMs).toBeGreaterThanOrEqual(scaled(60_000) - 20)
}, 10_000)

test('long-download: headers slower than the headers budget still return a 504', async () => {
  useFakeOwner({chunkGapsMs: [0], headersDelayMs: scaled(180_000)})

  const response = await fetchDuckdbOwnerProxyRequest(covidenceExportTemplate, 'http://owner.test', {
    ...scaledBudgets,
    longDownloadTimeoutMs: scaled(120_000),
  })

  expect(response.status).toBe(504)
  expect(await response.json()).toEqual({
    data: null,
    error: `DuckDB owner proxy target timed out after ${scaled(120_000)} ms`,
  })
}, 10_000)

test('long-download: with a known client connection, a stall drops the socket instead of ending the body', async () => {
  const dropWithoutCleanEnd = mock(() => {})
  useFakeOwner({chunkGapsMs: [scaled(1000), scaled(61_000)], headersDelayMs: 0})

  const response = await fetchDuckdbOwnerProxyRequest(
    {...covidenceExportTemplate, clientConnection: {dropWithoutCleanEnd}},
    'http://owner.test',
    scaledBudgets,
  )
  const reader = getBody(response).getReader()

  expect(new TextDecoder().decode((await reader.read()).value)).toBe('chunk-0;')

  const pendingRead = reader.read().then(
    () => {
      return 'settled'
    },
    () => {
      return 'errored'
    },
  )
  const outcome = await Promise.race([
    pendingRead,
    globalThis.Bun.sleep(scaled(60_000) + 300).then(() => {
      return 'still open'
    }),
  ])

  // Neither closed nor errored: Bun would turn either into a clean end of the chunked response.
  expect(outcome).toBe('still open')
  expect(dropWithoutCleanEnd).toHaveBeenCalledTimes(1)
  expect(
    getTimeoutWarnings().map(({key}) => {
      return key
    }),
  ).toEqual(['api-proxy:duckdb-owner-timeout:body-idle'])

  // Bun cancels the stream once it drops the socket; cancelling must settle cleanly.
  await reader.cancel(new Error('client socket closed'))
}, 10_000)
