import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

import {afterEach, expect, spyOn, test} from 'bun:test'

import {
  assertAppleContainerDatabaseHasNoLocks,
  assertAppleContainerDatabaseIsIdle,
} from './appleContainerHostDatabase.ts'
import {getAppleContainerCommands} from './runAppleContainer.ts'

const temporaryDirectories: string[] = []

afterEach(() => {
  temporaryDirectories.splice(0).map((directory) => {
    rmSync(directory, {recursive: true, force: true})
  })
})

test('refuses owner, writer and journal locks without deleting them', () => {
  const directory = mkdtempSync(join(tmpdir(), 'forska-container-lock-test-'))
  temporaryDirectories.push(directory)
  const databasePath = join(directory, 'forska.duckdb')
  writeFileSync(databasePath, '')
  expect(() => {
    return assertAppleContainerDatabaseHasNoLocks(databasePath)
  }).not.toThrow()
  for (const suffix of ['.duckdb-owner.lock', '.writer.lock']) {
    const lockPath = `${databasePath}${suffix}`
    mkdirSync(lockPath)
    expect(() => {
      return assertAppleContainerDatabaseHasNoLocks(databasePath)
    }).toThrow('Stop the host DB owner cleanly')
    rmSync(lockPath, {recursive: true})
  }
  const journalDirectory = join(directory, 'judge-worker-journals')
  mkdirSync(journalDirectory)
  const journalLock = join(journalDirectory, 'primary-judge-worker.sqlite.lock')
  writeFileSync(journalLock, 'preserve this lease')
  expect(() => {
    return assertAppleContainerDatabaseHasNoLocks(databasePath)
  }).toThrow('Stop the host DB owner cleanly')
})

test('maps the primary DB directory with spaces to the Linux profile path without shell splitting', () => {
  const directory = '/Users/test/Library/Application Support/Forska/runtime/primary'
  const hostDatabase = {
    directory,
    databasePath: join(directory, 'forska.duckdb'),
    assetsDirectory: '/repo with spaces/assets',
  }
  const run = getAppleContainerCommands({hostDatabase}).at(-1) ?? []
  expect(run).toContain(`${directory}:/data/share/forska/runtime/primary`)
  expect(run).toContain('/repo with spaces/assets:/data/assets')
  expect(
    run.some((argument) => {
      return argument.startsWith('DUCKDB_PATH=')
    }),
  ).toBe(false)
  expect(
    getAppleContainerCommands()
      .at(-1)
      ?.some((argument) => {
        return argument.includes(directory)
      }),
  ).toBe(false)
})

test('checks open WAL and journal sidecar handles before allowing a host database', () => {
  const directory = mkdtempSync(join(tmpdir(), 'forska-container-sidecar-test-'))
  temporaryDirectories.push(directory)
  const databasePath = join(directory, 'forska.duckdb')
  const journalPath = join(directory, 'judge-worker-journals', 'primary-judge-worker.sqlite')
  mkdirSync(join(directory, 'judge-worker-journals'))
  writeFileSync(databasePath, '')
  const sidecars = [`${databasePath}.wal`, `${journalPath}-wal`, `${journalPath}-shm`]
  sidecars.map((path) => {
    writeFileSync(path, '')
  })
  const which = spyOn(globalThis.Bun, 'which').mockReturnValue('/usr/sbin/lsof')
  const spawn = spyOn(globalThis.Bun, 'spawnSync').mockReturnValue({
    exitCode: 1,
    stdout: Buffer.from('1234\n'),
    stderr: Buffer.from(''),
  } as ReturnType<typeof globalThis.Bun.spawnSync>)
  try {
    expect(() => {
      return assertAppleContainerDatabaseIsIdle(databasePath)
    }).toThrow('The host database is open')
    expect(spawn.mock.calls[0]?.[0]).toEqual(['/usr/sbin/lsof', '-t', '--', databasePath, ...sidecars])
  } finally {
    which.mockRestore()
    spawn.mockRestore()
  }
})
