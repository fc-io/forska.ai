import {expect, test} from 'bun:test'

import {HttpError} from '../../utils/httpError.ts'
import {startDataSourceImportInBackground} from './startDataSourceImportInBackground.ts'

const waitFor = async (check: () => boolean) => {
  const deadline = Date.now() + 5000

  while (!check() && Date.now() < deadline) {
    await globalThis.Bun.sleep(5)
  }

  expect(check()).toBe(true)
}

test('background datasource import returns once started and rejects a second start until it settles', async () => {
  const harvest = Promise.withResolvers<undefined>()
  const events: string[] = []

  await startDataSourceImportInBackground({
    dataSourceId: 'guard-success',
    importRoute: '/api/datasources/import/pubmed',
    runImport: async (markImportStarted) => {
      markImportStarted()
      await harvest.promise
      events.push('updated')
    },
  })

  expect(events).toEqual([])
  const duplicate = startDataSourceImportInBackground({
    dataSourceId: 'guard-success',
    importRoute: '/api/datasources/import/pubmed',
    runImport: async (markImportStarted) => {
      markImportStarted()
      events.push('duplicate-ran')
    },
  })

  const duplicateError = await duplicate.catch((error: unknown) => {
    return error
  })

  expect(duplicateError).toBeInstanceOf(HttpError)
  expect((duplicateError as HttpError).status).toBe(409)

  await startDataSourceImportInBackground({
    dataSourceId: 'guard-other-source',
    importRoute: '/api/datasources/import/pubmed',
    runImport: async (markImportStarted) => {
      markImportStarted()
      events.push('other-source-ran')
    },
  })

  harvest.resolve(undefined)
  await waitFor(() => {
    return events.includes('updated')
  })

  await startDataSourceImportInBackground({
    dataSourceId: 'guard-success',
    importRoute: '/api/datasources/import/pubmed',
    runImport: async (markImportStarted) => {
      markImportStarted()
      events.push('restarted')
    },
  })

  expect(events).toEqual(['other-source-ran', 'updated', 'restarted'])
})

test('background datasource import releases the guard after the import fails', async () => {
  const harvest = Promise.withResolvers<undefined>()
  const runs: string[] = []

  await startDataSourceImportInBackground({
    dataSourceId: 'guard-failure',
    importRoute: '/api/datasources/import/medrxiv',
    runImport: async (markImportStarted) => {
      markImportStarted()
      await harvest.promise
    },
  })

  harvest.reject(new Error('harvest failed'))
  await globalThis.Bun.sleep(0)

  await startDataSourceImportInBackground({
    dataSourceId: 'guard-failure',
    importRoute: '/api/datasources/import/medrxiv',
    runImport: async (markImportStarted) => {
      markImportStarted()
      runs.push('restarted')
    },
  })

  expect(runs).toEqual(['restarted'])
})

test('background datasource import surfaces failures that happen before the import starts', async () => {
  const start = startDataSourceImportInBackground({
    dataSourceId: 'guard-before-start',
    importRoute: '/api/datasources/import/pubmed',
    runImport: async () => {
      throw new HttpError(409, 'Data source tracking import is already running')
    },
  })

  const startError = await start.catch((error: unknown) => {
    return error
  })

  expect(startError).toBeInstanceOf(HttpError)
  expect((startError as HttpError).message).toBe('Data source tracking import is already running')

  await startDataSourceImportInBackground({
    dataSourceId: 'guard-before-start',
    importRoute: '/api/datasources/import/pubmed',
    runImport: async (markImportStarted) => {
      markImportStarted()
    },
  })
})
