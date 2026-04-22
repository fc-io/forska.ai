import {expect, test} from 'bun:test'

import {isExpectedDuckdbOwnerRoleLossError} from './serverRuntimeRole.ts'

test('recognizes role loss duckdb errors', () => {
  expect(isExpectedDuckdbOwnerRoleLossError(new Error('Current server role api cannot own DuckDB'))).toBe(true)
  expect(isExpectedDuckdbOwnerRoleLossError(new Error('DuckDB owner lease is no longer owned by this process'))).toBe(
    true,
  )
})

test('ignores unrelated errors', () => {
  expect(isExpectedDuckdbOwnerRoleLossError(new Error('syntax error near select'))).toBe(false)
})
