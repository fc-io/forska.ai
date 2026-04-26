import {expect, test} from 'bun:test'

import {
  canServerRoleOwnDuckdb,
  getServerRoleCapabilities,
  productionServerRoles,
  shouldServerRoleMountJudgingCrons,
  shouldServerRoleMountMaintenanceCrons,
  shouldServerRoleRunCodexStartup,
} from './serverRole.ts'

test('maintenance-worker role can own duckdb', () => {
  expect(canServerRoleOwnDuckdb('maintenance-worker')).toBe(true)
})

test('api and judge-worker roles cannot own duckdb', () => {
  expect(canServerRoleOwnDuckdb('api')).toBe(false)
  expect(canServerRoleOwnDuckdb('judge-worker')).toBe(false)
})

test('maintenance-worker role mounts maintenance crons only', () => {
  expect(shouldServerRoleMountMaintenanceCrons('maintenance-worker')).toBe(true)
  expect(shouldServerRoleMountJudgingCrons('maintenance-worker')).toBe(false)
})

test('cutover production maintenance crons mount only on maintenance-worker', () => {
  expect(productionServerRoles.filter(shouldServerRoleMountMaintenanceCrons)).toEqual(['maintenance-worker'])
  expect(shouldServerRoleMountMaintenanceCrons('auto')).toBe(false)
})

test('judge-worker role mounts judging crons only', () => {
  expect(shouldServerRoleMountJudgingCrons('judge-worker')).toBe(true)
  expect(shouldServerRoleMountMaintenanceCrons('judge-worker')).toBe(false)
})

test('server role capabilities describe the current split of responsibilities', () => {
  expect(getServerRoleCapabilities('api')).toEqual(['api', 'owner-proxy'])
  expect(getServerRoleCapabilities('maintenance-worker')).toEqual(['duckdb-owner', 'maintenance'])
  expect(getServerRoleCapabilities('judge-worker')).toEqual(['judging'])
  expect(getServerRoleCapabilities('dev-single')).toEqual(['api', 'duckdb-owner', 'maintenance', 'judging'])
  expect(getServerRoleCapabilities('auto')).toEqual(['api', 'owner-proxy'])
})

test('codex startup runs only on api-facing roles', () => {
  expect(shouldServerRoleRunCodexStartup('api')).toBe(true)
  expect(shouldServerRoleRunCodexStartup('dev-single')).toBe(true)
  expect(shouldServerRoleRunCodexStartup('judge-worker')).toBe(false)
  expect(shouldServerRoleRunCodexStartup('maintenance-worker')).toBe(false)
  expect(shouldServerRoleRunCodexStartup('auto')).toBe(false)
})
