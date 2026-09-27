import {afterEach, expect, test} from 'bun:test'

import {createDuckdbShuttingDownError} from './duckdbShuttingDownError.ts'
import {
  isExpectedDuckdbOwnerRoleLossError,
  shouldCurrentServerRunMaintenanceLoops,
  withCurrentServerRoleOverride,
} from './serverRuntimeRole.ts'
import {markServerShutdownStarted, resetServerShutdownStateForTests} from './serverShutdownState.ts'

afterEach(() => {
  resetServerShutdownStateForTests()
})

test('recognizes role loss duckdb errors', () => {
  expect(isExpectedDuckdbOwnerRoleLossError(new Error('Current server role api cannot own DuckDB'))).toBe(true)
  expect(isExpectedDuckdbOwnerRoleLossError(new Error('DuckDB owner lease is no longer owned by this process'))).toBe(
    true,
  )
})

test('ignores unrelated errors', () => {
  expect(isExpectedDuckdbOwnerRoleLossError(new Error('syntax error near select'))).toBe(false)
})

test('treats DuckDB shutdown rejections as expected owner role loss so crons skip quietly', () => {
  const shutdownError = createDuckdbShuttingDownError('mainQuery for judgmentsJobs.import')

  expect(isExpectedDuckdbOwnerRoleLossError(shutdownError)).toBe(true)
  expect(isExpectedDuckdbOwnerRoleLossError(new Error(`${shutdownError.message} -- duckdb main query: SELECT 1`))).toBe(
    true,
  )
})

test('maintenance loops and crons stop running once graceful shutdown started', async () => {
  await withCurrentServerRoleOverride('maintenance-worker', async () => {
    expect(shouldCurrentServerRunMaintenanceLoops()).toBe(true)
    markServerShutdownStarted('SIGTERM')
    expect(shouldCurrentServerRunMaintenanceLoops()).toBe(false)
  })
})
