import {expect, test} from 'bun:test'

import {runReviewServingCurrentDbTabCountParity} from './checkReviewServingCurrentDbTabCountParity.ts'

test('current-db tab-count parity script closes DuckDB without forcing a checkpoint', async () => {
  const closeCalls: Array<{checkpointBeforeClose?: boolean}> = []

  await runReviewServingCurrentDbTabCountParity({
    closeDuckdbService: async (options) => {
      closeCalls.push(options ?? {})
    },
    work: async () => {},
  })

  expect(closeCalls).toEqual([{checkpointBeforeClose: false}])
})

test('current-db tab-count parity script closes DuckDB after parity failure', async () => {
  const closeCalls: Array<{checkpointBeforeClose?: boolean}> = []
  const parityError = new Error('parity failed')

  await expect(
    runReviewServingCurrentDbTabCountParity({
      closeDuckdbService: async (options) => {
        closeCalls.push(options ?? {})
      },
      work: async () => {
        throw parityError
      },
    }),
  ).rejects.toThrow('parity failed')

  expect(closeCalls).toEqual([{checkpointBeforeClose: false}])
})
