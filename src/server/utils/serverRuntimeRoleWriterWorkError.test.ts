import {expect, test} from 'bun:test'

import {isExpectedWriterRoleLossError} from './serverRuntimeRole.ts'

test('recognizes role loss duckdb errors', () => {
  expect(isExpectedWriterRoleLossError(new Error('Current server role api cannot own DuckDB'))).toBe(true)
  expect(isExpectedWriterRoleLossError(new Error('DuckDB owner lease is no longer owned by this process'))).toBe(true)
  expect(isExpectedWriterRoleLossError(new Error('DuckDB writer lease is no longer owned by this process'))).toBe(true)
})

test('ignores unrelated errors', () => {
  expect(isExpectedWriterRoleLossError(new Error('syntax error near select'))).toBe(false)
})
