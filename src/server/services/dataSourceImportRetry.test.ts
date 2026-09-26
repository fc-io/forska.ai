import {expect, test} from 'bun:test'

import {
  dataSourceImportPageRetryDelaysMs,
  isTransientDataSourceImportError,
  withDataSourceImportPageRetry,
} from './dataSourceImportRetry.ts'

test('owner freezes, restarts and connection errors are transient data source import errors', () => {
  const transientMessages = [
    'DuckDB workload budget exceeded for import.storeArticles: duration 487605ms exceeded timeout 120000ms',
    'TransactionContext Error: Current transaction is aborted (please ROLLBACK)',
    'FATAL Error: database has been invalidated because of a previous fatal error',
    'DuckDB connection not started',
    'DuckDB instance not started',
    'IO Error: Could not set lock on file "forska.duckdb": Conflicting lock is held',
    'TransactionContext Error: Catalog write-write conflict on alter with "data_source"',
    'The operation timed out.',
    'Unable to connect. Is the computer able to access the url?',
    'read ECONNRESET',
    'fetch failed',
    'DuckDB owner lease is no longer owned by this process',
    'DuckDB is reserved for project-transfer commit work; rejecting transaction for import.storeArticles until the import phase completes',
    'Europe PMC HTTP 503',
    'medRxiv HTTP 429',
  ]

  expect(
    transientMessages.filter((message) => {
      return !isTransientDataSourceImportError(new Error(message))
    }),
  ).toEqual([])
})

test('lease loss, missing or archived sources, validation and unknown errors are not transient', () => {
  const permanentMessages = [
    'Data source import lease was lost',
    'Data source not found',
    'Data source is archived',
    'Validation failed for PubMed entry 3: must be a string',
    'Data source import lease was lost after timeout',
    'Europe PMC HTTP 404',
    'Invalid response from Europe PMC',
    "Cannot read properties of undefined (reading 'id')",
  ]

  expect(
    permanentMessages.filter((message) => {
      return isTransientDataSourceImportError(new Error(message))
    }),
  ).toEqual([])
})

test('page retry backs off over a few minutes and stops after the last delay', () => {
  expect(dataSourceImportPageRetryDelaysMs).toEqual([10_000, 30_000, 60_000, 120_000])
  expect(
    dataSourceImportPageRetryDelaysMs.reduce((total, delayMs) => {
      return total + delayMs
    }, 0),
  ).toBe(220_000)
})

test('page retry repeats the same page after a transient failure until it succeeds', async () => {
  const attempts: string[] = []
  const result = await withDataSourceImportPageRetry(
    'PubMed page 7',
    async () => {
      attempts.push(`attempt-${attempts.length + 1}`)
      if (attempts.length < 3) {
        throw new Error('DuckDB workload budget exceeded for import.storeArticles: duration 487605ms')
      }

      return 'stored'
    },
    [0, 0, 0, 0],
  )

  expect(result).toBe('stored')
  expect(attempts).toEqual(['attempt-1', 'attempt-2', 'attempt-3'])
})

test('page retry gives up with the last error once every delay is used', async () => {
  const attempts: number[] = []
  const error = await withDataSourceImportPageRetry(
    'PubMed page 7',
    async () => {
      attempts.push(attempts.length + 1)
      throw new Error(`The operation timed out (${attempts.length})`)
    },
    [0, 0],
  ).then(
    () => {
      return null
    },
    (caught: unknown) => {
      return caught
    },
  )

  expect(attempts).toEqual([1, 2, 3])
  expect(String(error)).toContain('The operation timed out (3)')
})

test('page retry fails right away on a non-transient error', async () => {
  const attempts: number[] = []
  const error = await withDataSourceImportPageRetry(
    'PubMed page 7',
    async () => {
      attempts.push(attempts.length + 1)
      throw new Error('Data source import lease was lost')
    },
    [0, 0, 0, 0],
  ).then(
    () => {
      return null
    },
    (caught: unknown) => {
      return caught
    },
  )

  expect(attempts).toEqual([1])
  expect(String(error)).toContain('Data source import lease was lost')
})
