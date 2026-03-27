import {expect, test} from 'bun:test'

import {canServerRoleOwnDuckdb, shouldServerRoleMountWriterCrons} from './serverRole.ts'

test('worker role can own duckdb', () => {
  expect(canServerRoleOwnDuckdb('worker')).toBe(true)
})

test('worker role mounts writer crons', () => {
  expect(shouldServerRoleMountWriterCrons('worker')).toBe(true)
})
