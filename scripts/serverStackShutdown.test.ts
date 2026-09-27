import {expect, test} from 'bun:test'

import {
  getDevServerWatchStackShutdownTimeoutMs,
  getServerStackRoleShutdownTimeoutMs,
  getServerStackShutdownBudgetMs,
  getServerStackShutdownTimeouts,
  type ServerStackManagedRole,
  serverStackShutdownDefaultTimeouts,
  stopServerStackRolesInOrder,
} from './serverStackShutdown.ts'

const createDeferred = () => {
  return Promise.withResolvers<undefined>()
}

test('stack shutdown stops api and judge together before it stops the DuckDB owner', async () => {
  const events: string[] = []
  const stops = {api: createDeferred(), judge: createDeferred(), maintenance: createDeferred()}
  const stopping = stopServerStackRolesInOrder(async (role: ServerStackManagedRole) => {
    events.push(`stop ${role}`)
    await stops[role].promise
    events.push(`stopped ${role}`)
  })

  await globalThis.Bun.sleep(1)
  expect(events).toEqual(['stop api', 'stop judge'])

  stops.judge.resolve(undefined)
  await globalThis.Bun.sleep(1)
  expect(events).toEqual(['stop api', 'stop judge', 'stopped judge'])

  stops.api.resolve(undefined)
  await globalThis.Bun.sleep(1)
  expect(events).toEqual(['stop api', 'stop judge', 'stopped judge', 'stopped api', 'stop maintenance'])

  stops.maintenance.resolve(undefined)

  expect(await stopping).toEqual([])
  expect(events.at(-1)).toBe('stopped maintenance')
})

test('stack shutdown still stops the DuckDB owner when a worker fails to stop and reports the failure', async () => {
  const stoppedRoles: ServerStackManagedRole[] = []

  const errors = await stopServerStackRolesInOrder(async (role) => {
    if (role === 'judge') {
      throw new Error('judge pids=42 did not exit')
    }

    stoppedRoles.push(role)
  })

  expect(stoppedRoles).toEqual(['api', 'maintenance'])
  expect(errors).toEqual([new Error('judge pids=42 did not exit')])
})

test('the DuckDB owner gets a 240s shutdown budget while api and judge keep 20s', () => {
  const timeouts = getServerStackShutdownTimeouts({})

  expect(timeouts).toEqual(serverStackShutdownDefaultTimeouts)
  expect(getServerStackRoleShutdownTimeoutMs('maintenance', timeouts)).toBe(240_000)
  expect(getServerStackRoleShutdownTimeoutMs('api', timeouts)).toBe(20_000)
  expect(getServerStackRoleShutdownTimeoutMs('judge', timeouts)).toBe(20_000)
  expect(getServerStackShutdownBudgetMs(timeouts)).toBe(270_000)
})

test('the owner shutdown budget is configurable and grows with larger DuckDB shutdown timeouts', () => {
  expect(
    getServerStackShutdownTimeouts({FORSKA_SERVER_STACK_MAINTENANCE_SHUTDOWN_TIMEOUT_MS: '600000'})
      .maintenanceShutdownTimeoutMs,
  ).toBe(600_000)
  expect(
    getServerStackShutdownTimeouts({FORSKA_SERVER_STACK_MAINTENANCE_SHUTDOWN_TIMEOUT_MS: 'later'})
      .maintenanceShutdownTimeoutMs,
  ).toBe(240_000)
  expect(
    getServerStackShutdownTimeouts({FORSKA_DUCKDB_SHUTDOWN_CHECKPOINT_TIMEOUT_MS: '600000'})
      .maintenanceShutdownTimeoutMs,
  ).toBe(45_000 + 15_000 + 600_000 + 30_000 + 10_000)
})

test('the dev watcher escalation deadline outlasts the whole stack shutdown budget', () => {
  const stackBudgetMs = getServerStackShutdownBudgetMs(getServerStackShutdownTimeouts({}))

  expect(getDevServerWatchStackShutdownTimeoutMs({})).toBe(300_000)
  expect(getDevServerWatchStackShutdownTimeoutMs({})).toBeGreaterThan(stackBudgetMs)
  expect(getDevServerWatchStackShutdownTimeoutMs({FORSKA_SERVER_STACK_MAINTENANCE_SHUTDOWN_TIMEOUT_MS: '600000'})).toBe(
    20_000 + 5_000 + 600_000 + 5_000 + 30_000,
  )
})
