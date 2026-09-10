import {expect, test} from 'bun:test'

import {normalizeDuckdbMemoryLimit, parseDuckdbMemoryLimitToMiB} from './duckdbMemoryLimit.ts'

test('normalizes unitless DuckDB memory limits as GB', () => {
  expect(normalizeDuckdbMemoryLimit('16')).toBe('16GB')
  expect(normalizeDuckdbMemoryLimit(' 1.5 ')).toBe('1.5GB')
  expect(normalizeDuckdbMemoryLimit('6400MiB')).toBe('6400MiB')
  expect(normalizeDuckdbMemoryLimit(' 10 GB ')).toBe('10 GB')
  expect(normalizeDuckdbMemoryLimit('not-a-limit')).toBe('not-a-limit')
  expect(normalizeDuckdbMemoryLimit('   ')).toBeNull()
})

test('parses unitless DuckDB memory limits as decimal GB', () => {
  expect(parseDuckdbMemoryLimitToMiB('16')).toBe(Math.floor((16 * 1000 ** 3) / 1024 ** 2))
  expect(parseDuckdbMemoryLimitToMiB('1.5')).toBe(Math.floor((1.5 * 1000 ** 3) / 1024 ** 2))
  expect(parseDuckdbMemoryLimitToMiB('6400MiB')).toBe(6400)
  expect(parseDuckdbMemoryLimitToMiB('not-a-limit')).toBeNull()
})
