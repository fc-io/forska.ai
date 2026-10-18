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

test('the shipped constants produce twenty-four distinct strategies on canonical-v1', () => {
  const shippedInputs = getShippedFullTextStrategyInputs()

  expect(shippedInputs).toHaveLength(24)
  expect(new Set(shippedInputs.map(getFullTextStrategyId)).size).toBe(24)
  expect(
    new Set(
      shippedInputs.map((inputs) => {
        return inputs.canonicalTextVersion
      }),
    ),
  ).toEqual(new Set(['canonical-v1']))
})

test('shipped strategies cover exactly figure modes none and native_images', () => {
  const figureModeTransports = new Set(
    getShippedFullTextStrategyInputs().map((inputs) => {
      return `${inputs.figureMode}:${String(inputs.imageTransportVersion)}:${String(inputs.imageTokenEstimateVersion)}`
    }),
  )

  expect(figureModeTransports).toEqual(new Set(['native_images:img-v1:img-tok-v1', 'none:null:undefined']))
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

test('registry entries carry only none and native_images inputs and no figure-description inputs', () => {
  expect(
    new Set(
      fullTextStrategyRegistry.map((entry) => {
        return entry.inputs.figureMode
      }),
    ),
  ).toEqual(new Set(['native_images', 'none']))
  expect(
    fullTextStrategyRegistry.filter((entry) => {
      return Object.keys(entry.inputs).some((key) => {
        return key.startsWith('figureDescription')
      })
    }),
  ).toEqual([])
})

test('text-only shipped strategies carry no imageTokenEstimateVersion key, so their ids did not move', () => {
  expect(
    getShippedFullTextStrategyInputs()
      .filter((inputs) => {
        return inputs.figureMode === 'none'
      })
      .filter((inputs) => {
        return Object.hasOwn(inputs, 'imageTokenEstimateVersion')
      }),
  ).toEqual([])
})

test('the shipped layout-v2 strategy ids are frozen', () => {
  const shippedIdsByLabel = Object.fromEntries(
    getShippedFullTextStrategyInputs()
      .map(getFullTextStrategy)
      .map((strategy) => {
        return [strategy.label, strategy.id]
      }),
  )

  expect(shippedIdsByLabel['mineru 4.0.12 / none / single 24k']).toBe('fts-66cd6ec607091a59')
  expect(shippedIdsByLabel['mineru 4.0.12 / native images / chunked 24k']).toBe('fts-074936d3b17dc424')
  expect(shippedIdsByLabel['mineru 4.0.12 / native images / chunked 48k']).toBe('fts-fd40fe255df5a2c3')
  expect(shippedIdsByLabel['docling 1.37.0 / none / chunked 96k']).toBe('fts-92a3cf9c8e585a22')
  expect(shippedIdsByLabel['docling 1.37.0 / native images / single 24k']).toBe('fts-386400411638ed40')
})
