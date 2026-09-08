import {existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs'
import {hostname} from 'node:os'
import {join} from 'node:path'

import {afterEach, expect, test} from 'bun:test'
import {Effect} from 'effect'

import {getLocalMachineFingerprint} from '../src/server/utils/localMachineIdentity.ts'
import {releaseStoppedServerLocks} from './releaseStoppedServerLocks.ts'

const directories: string[] = []

afterEach(() => {
  directories.splice(0).map((directory) => {
    rmSync(directory, {recursive: true, force: true})
  })
})

const createFixture = async (role: 'maintenance' | 'judge') => {
  const root = join(process.cwd(), 'data', 'runtime')
  mkdirSync(root, {recursive: true})
  const directory = mkdtempSync(join(root, 'stopped-server-locks-'))
  directories.push(directory)
  const databasePath = join(directory, 'forska.duckdb')
  const journalPath = join(directory, 'judge.sqlite')
  const lockPath = role === 'maintenance' ? `${databasePath}.duckdb-owner.lock` : `${journalPath}.lock`
  const child = globalThis.Bun.spawn([process.execPath, '-e', 'process.exit(0)'])
  await child.exited
  const server = {
    pid: child.pid,
    processStartedAt: '2026-01-01T00:00:00.000Z',
    exitedAt: '2026-01-01T00:00:02.000Z',
    role,
    envValues: {DUCKDB_PATH: databasePath, JUDGE_WORKER_JOURNAL_PATH: journalPath},
  }
  const metadata = {
    acquiredAt: '2026-01-01T00:00:01.000Z',
    heartbeatAt: '2026-01-01T00:00:01.000Z',
    pid: child.pid,
    hostname: hostname(),
    machineFingerprint: getLocalMachineFingerprint(),
    leaseId: 'stopped-server-lease',
    databasePath,
    journalPath,
    apiServerPort: 3002,
    runtimeVersion: 'split-runtime-v1',
    serverRole: 'maintenance-worker',
    workerId: 'test-worker',
  }
  writeFileSync(lockPath, JSON.stringify(metadata))
  writeFileSync(databasePath, 'database must remain unchanged')
  writeFileSync(`${databasePath}.wal`, 'WAL must remain unchanged')
  return {server, metadata, lockPath, databasePath}
}

for (const role of ['maintenance', 'judge'] as const) {
  test(`${role} supervisor removes only the exited child's lease, never database or WAL`, async () => {
    const fixture = await createFixture(role)
    await Effect.runPromise(releaseStoppedServerLocks(fixture.server))
    expect(existsSync(fixture.lockPath)).toBe(false)
    expect(readFileSync(fixture.databasePath, 'utf8')).toBe('database must remain unchanged')
    expect(readFileSync(`${fixture.databasePath}.wal`, 'utf8')).toBe('WAL must remain unchanged')
    await Effect.runPromise(releaseStoppedServerLocks(fixture.server))
  })

  test.each([
    {name: 'foreign host', metadata: {hostname: 'foreign-container', machineFingerprint: 'foreign-machine'}},
    {name: 'different PID', metadata: {pid: process.pid}},
    {name: 'older process lifetime', metadata: {acquiredAt: '2025-12-31T23:59:59.999Z'}},
    {name: 'replacement after exit', metadata: {acquiredAt: '2026-01-01T00:00:02.001Z'}},
    {name: 'invalid acquisition time', metadata: {acquiredAt: 'not-a-date'}},
  ])(`${role} preserves $name lease`, async ({metadata}) => {
    const fixture = await createFixture(role)
    const contents = JSON.stringify({...fixture.metadata, ...metadata})
    writeFileSync(fixture.lockPath, contents)
    await Effect.runPromise(releaseStoppedServerLocks(fixture.server))
    expect(readFileSync(fixture.lockPath, 'utf8')).toBe(contents)
  })

  test(`${role} cannot release a matching lease while its PID is still alive`, async () => {
    const fixture = await createFixture(role)
    const contents = JSON.stringify({...fixture.metadata, pid: process.pid})
    writeFileSync(fixture.lockPath, contents)
    await Effect.runPromise(releaseStoppedServerLocks({...fixture.server, pid: process.pid}))
    expect(readFileSync(fixture.lockPath, 'utf8')).toBe(contents)
  })
}
