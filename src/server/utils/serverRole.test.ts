import {expect, test} from 'bun:test'

import {canServerRoleOwnDuckdb, getServerRoleCapabilities, shouldServerRoleMountWriterCrons} from './serverRole.ts'

test('worker role can own duckdb', () => {
  expect(canServerRoleOwnDuckdb('worker')).toBe(true)
})

test('worker role mounts writer crons', () => {
  expect(shouldServerRoleMountWriterCrons('worker')).toBe(true)
})

test('server role capabilities describe the current split of responsibilities', () => {
  expect(getServerRoleCapabilities('api')).toEqual(['api'])
  expect(getServerRoleCapabilities('worker')).toEqual(['duckdb-owner', 'maintenance', 'judging'])
  expect(getServerRoleCapabilities('writer')).toEqual(['duckdb-owner', 'maintenance', 'judging'])
  expect(getServerRoleCapabilities('dev-single')).toEqual(['api', 'duckdb-owner', 'maintenance', 'judging'])
})
