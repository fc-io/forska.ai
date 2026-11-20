import {afterEach, beforeEach, expect, mock, test} from 'bun:test'

import {isTransientDataSourceImportError} from '../../server/services/dataSourceImportRetry.ts'

type StoredCall = {importRoute: string; recordIds: string[]}
type CursorCall = {cursor: string | null; fetchedCount: number | undefined}

const sleepModulePath = new URL('../../utils/sleep.ts', import.meta.url).href
const storeModulePath = new URL('./arxivWorkflowStoreEntires.ts', import.meta.url).href
const realStoreModule = await import('./arxivWorkflowStoreEntires.ts')
const storedCallsRef: {current: StoredCall[]} = {current: []}
const sleepCallsRef: {current: number[]} = {current: []}
const originalFetch = globalThis.fetch

void mock.module(sleepModulePath, () => {
  return {
    sleep: async (ms: number) => {
      sleepCallsRef.current.push(ms)
    },
  }
})

void mock.module(storeModulePath, () => {
  return {
    arxivEntry: realStoreModule.arxivEntry,
    arxivWorkflowStoreEntires: async (records: Array<{id: string}>, importRoute: string) => {
      storedCallsRef.current.push({
        importRoute,
        recordIds: records.map((record) => {
          return record.id
        }),
      })
    },
  }
})

const {arxivWorkflowHarvest} = await import('./arxivWorkflowHarvest.ts')

const oaiListRecordsXml = `<?xml version="1.0" encoding="UTF-8"?>
<OAI-PMH xmlns="http://www.openarchives.org/OAI/2.0/">
  <responseDate>2026-10-09T00:00:00Z</responseDate>
  <request verb="ListRecords" metadataPrefix="arXiv">https://oaipmh.arxiv.org/oai</request>
  <ListRecords>
    <record>
      <header>
        <identifier>oai:arXiv.org:2401.00001</identifier>
        <datestamp>2026-10-01</datestamp>
      </header>
      <metadata>
        <arXiv xmlns="http://arxiv.org/OAI/arXiv/">
          <id>2401.00001</id>
          <title>Example paper</title>
          <abstract>Example abstract.</abstract>
          <authors><author><keyname>Doe</keyname><forenames>Jane</forenames></author></authors>
          <categories>cs.AI</categories>
        </arXiv>
      </metadata>
    </record>
  </ListRecords>
</OAI-PMH>`

const getHarvestInput = (cursorCalls: CursorCall[]) => {
  return {
    cursor: null,
    fromDate: '2026-10-01',
    importRoute: '/api/datasources/import/arxiv',
    onCursorUpdate: async (cursor: string | null, progress?: {fetchedCount: number}) => {
      cursorCalls.push({cursor, fetchedCount: progress?.fetchedCount})
    },
    toDate: '2026-10-08',
  }
}

const installFetchResponses = (responses: Response[]) => {
  const calls: string[] = []
  const remaining = [...responses]

  globalThis.fetch = (async (input: string | URL) => {
    calls.push(typeof input === 'string' ? input : input.href)
    const response = remaining.shift()

    if (!response) {
      throw new Error('Unexpected arXiv fetch')
    }

    return response
  }) as typeof fetch

  return calls
}

const getUnavailableResponse = (retryAfterSeconds?: number) => {
  return new Response('<html>Retry after 5 seconds</html>', {
    headers: retryAfterSeconds === undefined ? {} : {'retry-after': String(retryAfterSeconds)},
    status: 503,
    statusText: 'Service Unavailable',
  })
}

beforeEach(() => {
  storedCallsRef.current = []
  sleepCallsRef.current = []
})

afterEach(() => {
  globalThis.fetch = originalFetch
})

test('a 503 with retry-after is retried in place and the page is stored once it succeeds', async () => {
  const cursorCalls: CursorCall[] = []
  const fetchCalls = installFetchResponses([
    getUnavailableResponse(7),
    new Response(oaiListRecordsXml, {headers: {'content-type': 'text/xml'}, status: 200}),
  ])

  await arxivWorkflowHarvest(getHarvestInput(cursorCalls))

  expect(fetchCalls).toHaveLength(2)
  expect(sleepCallsRef.current).toEqual([7000])
  expect(storedCallsRef.current).toEqual([
    {importRoute: '/api/datasources/import/arxiv', recordIds: ['oai:arXiv.org:2401.00001']},
  ])
  expect(cursorCalls).toEqual([{cursor: null, fetchedCount: 1}])
})

test('a persistent 503 fails with a transient HTTP error instead of a permanent validation error', async () => {
  const cursorCalls: CursorCall[] = []
  const fetchCalls = installFetchResponses([
    getUnavailableResponse(),
    getUnavailableResponse(),
    getUnavailableResponse(),
    getUnavailableResponse(),
    getUnavailableResponse(),
  ])

  const error = await arxivWorkflowHarvest(getHarvestInput(cursorCalls)).then(
    () => {
      return null
    },
    (reason: unknown) => {
      return reason
    },
  )

  expect(error).toBeInstanceOf(Error)
  expect((error as Error).message).toBe('arXiv HTTP 503')
  expect(isTransientDataSourceImportError(error)).toBe(true)
  expect(fetchCalls).toHaveLength(5)
  expect(sleepCallsRef.current).toEqual([5000, 15_000, 60_000, 300_000])
  expect(storedCallsRef.current).toEqual([])
  expect(cursorCalls).toEqual([])
})

test('a 4xx response fails immediately without retrying or storing', async () => {
  const cursorCalls: CursorCall[] = []
  const fetchCalls = installFetchResponses([new Response('badArgument', {status: 400, statusText: 'Bad Request'})])

  const error = await arxivWorkflowHarvest(getHarvestInput(cursorCalls)).then(
    () => {
      return null
    },
    (reason: unknown) => {
      return reason
    },
  )

  expect((error as Error).message).toBe('arXiv HTTP 400')
  expect(isTransientDataSourceImportError(error)).toBe(false)
  expect(fetchCalls).toHaveLength(1)
  expect(sleepCallsRef.current).toEqual([])
  expect(storedCallsRef.current).toEqual([])
})
