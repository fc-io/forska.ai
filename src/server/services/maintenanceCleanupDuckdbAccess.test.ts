import {readFileSync} from 'node:fs'
import {join} from 'node:path'

import {expect, test} from 'bun:test'

const projectRoot = process.cwd()

const readSource = (path: string) => {
  return readFileSync(join(projectRoot, path), 'utf8')
}

const countMatches = (source: string, pattern: RegExp) => {
  return source.match(pattern)?.length ?? 0
}

test('archived project cleanup uses explicit maintenance workload context for owner DB calls', () => {
  const source = readSource('src/server/services/archivedProjectCleanupService.ts')

  expect(source).toContain("getMaintenanceDuckdbWorkloadContext('archivedProjectCleanup')")
  expect(countMatches(source, /getAppDatabaseService\(\)\.queryJson</g)).toBe(3)
  expect(countMatches(source, /getAppDatabaseService\(\)\.transaction\(/g)).toBe(6)
  expect(countMatches(source, /getAppDatabaseService\(\)\.run\(/g)).toBe(2)
  expect(countMatches(source, /archivedProjectCleanupWorkloadContext/g)).toBe(12)
})

test('maintenance work leases use explicit maintenance workload context for owner DB calls', () => {
  const source = readSource('src/server/services/maintenanceWorkLeaseService.ts')

  expect(source).toContain("getMaintenanceDuckdbWorkloadContext('maintenanceWorkLease')")
  expect(countMatches(source, /getAppDatabaseService\(\)\.queryJson</g)).toBe(4)
  expect(countMatches(source, /getAppDatabaseService\(\)\.run\(/g)).toBe(3)
  expect(countMatches(source, /maintenanceWorkLeaseWorkloadContext/g)).toBe(8)
})
