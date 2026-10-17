import {expect, test} from 'bun:test'

import {getFullTextStrategy, getFullTextStrategyId, getFullTextStrategyLabel} from './fullTextStrategy.ts'
import {fullTextStrategyRegistry, getShippedFullTextStrategyInputs} from './fullTextStrategyRegistry.ts'

const today = new Date().toISOString().slice(0, 10)

test('every strategy the shipped constants produce is in the registry', () => {
  const registryIds = new Set(
    fullTextStrategyRegistry.map((entry) => {
      return entry.id
    }),
  )
  const missingEntries = getShippedFullTextStrategyInputs()
    .map(getFullTextStrategy)
    .filter((strategy) => {
      return !registryIds.has(strategy.id)
    })
    .map((strategy) => {
      return {firstSeen: today, ...strategy}
    })

  expect(
    missingEntries,
    `A shipped full-text strategy constant changed. Add these entries to fullTextStrategyRegistry and a FULL-PLAN.md revision log row:\n${JSON.stringify(missingEntries, null, 2)}`,
  ).toEqual([])
})

test('the shipped constants produce twelve distinct strategies on canonical-v1', () => {
  const shippedInputs = getShippedFullTextStrategyInputs()

  expect(shippedInputs).toHaveLength(12)
  expect(new Set(shippedInputs.map(getFullTextStrategyId)).size).toBe(12)
  expect(
    new Set(
      shippedInputs.map((inputs) => {
        return inputs.canonicalTextVersion
      }),
    ),
  ).toEqual(new Set(['canonical-v1']))
})

test('registry entries are self-consistent, unique and dated', () => {
  const ids = fullTextStrategyRegistry.map((entry) => {
    return entry.id
  })

  expect(new Set(ids).size).toBe(ids.length)
  expect(
    fullTextStrategyRegistry.filter((entry) => {
      return (
        entry.id !== getFullTextStrategyId(entry.inputs)
        || entry.label !== getFullTextStrategyLabel(entry.inputs)
        || !/^\d{4}-\d{2}-\d{2}$/.test(entry.firstSeen)
      )
    }),
  ).toEqual([])
})
