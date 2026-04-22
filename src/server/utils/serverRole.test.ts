import {expect, test} from 'bun:test'

import {
  canServerRoleOwnDuckdb,
  getServerRoleCapabilities,
  shouldServerRoleMountJudgingCrons,
  shouldServerRoleMountMaintenanceCrons,
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

test('judge-worker role mounts judging crons only', () => {
  expect(shouldServerRoleMountJudgingCrons('judge-worker')).toBe(true)
  expect(shouldServerRoleMountMaintenanceCrons('judge-worker')).toBe(false)
})

test('server role capabilities describe the current split of responsibilities', () => {
  expect(getServerRoleCapabilities('api')).toEqual(['api', 'owner-proxy'])
  expect(getServerRoleCapabilities('maintenance-worker')).toEqual(['duckdb-owner', 'maintenance'])
  expect(getServerRoleCapabilities('judge-worker')).toEqual(['judging'])
  expect(getServerRoleCapabilities('worker')).toEqual(['duckdb-owner', 'maintenance', 'judging'])
  expect(getServerRoleCapabilities('writer')).toEqual(['duckdb-owner', 'maintenance', 'judging'])
  expect(getServerRoleCapabilities('dev-single')).toEqual(['api', 'duckdb-owner', 'maintenance', 'judging'])
  expect(getServerRoleCapabilities('auto')).toEqual(['api', 'owner-proxy'])
})
