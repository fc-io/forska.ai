import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

import {afterEach, expect, test} from 'bun:test'

import {acquireDesktopSingleInstance} from './desktopSingleInstance.ts'

const tempPaths: string[] = []

const createLockPath = () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'forska-desktop-single-instance-'))
  tempPaths.push(tempDir)
  return join(tempDir, 'desktop.lock.json')
}

afterEach(() => {
  tempPaths.splice(0).map((tempPath) => {
    return rmSync(tempPath, {force: true, recursive: true})
  })
})

test('acquires the desktop lock when no other instance exists', () => {
  const lockPath = createLockPath()
  const result = acquireDesktopSingleInstance({
    acquiredAt: '2026-04-17T10:00:00.000Z',
    leaseId: 'lease-1',
    lockPath,
    pid: 101,
  })

  expect(result.status).toBe('acquired')
  expect(readFileSync(lockPath, 'utf8')).toContain('"leaseId": "lease-1"')

  result.status === 'acquired' ? result.release() : null

  expect(() => {
    return readFileSync(lockPath, 'utf8')
  }).toThrow()
})

test('refuses a second live desktop instance', () => {
  const lockPath = createLockPath()

  writeFileSync(
    lockPath,
    `${JSON.stringify({acquiredAt: '2026-04-17T10:00:00.000Z', leaseId: 'lease-1', pid: 101}, null, 2)}\n`,
    'utf8',
  )

  const result = acquireDesktopSingleInstance({
    isProcessAliveValue: (pid) => {
      return pid === 101
    },
    leaseId: 'lease-2',
    lockPath,
    pid: 202,
  })

  expect(result).toMatchObject({existing: {leaseId: 'lease-1', pid: 101}, status: 'already-running'})
})

test('reclaims a stale desktop lock', () => {
  const lockPath = createLockPath()

  writeFileSync(
    lockPath,
    `${JSON.stringify({acquiredAt: '2026-04-17T10:00:00.000Z', leaseId: 'lease-1', pid: 101}, null, 2)}\n`,
    'utf8',
  )

  const result = acquireDesktopSingleInstance({
    isProcessAliveValue: () => {
      return false
    },
    leaseId: 'lease-2',
    lockPath,
    pid: 202,
  })

  expect(result.status).toBe('acquired')
  expect(readFileSync(lockPath, 'utf8')).toContain('"leaseId": "lease-2"')
})
