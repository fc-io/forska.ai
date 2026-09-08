import {existsSync, realpathSync, statSync} from 'node:fs'
import {dirname, join} from 'node:path'

import {getRuntimeProfileDataRoot} from '../src/utils/runtimeProfile.ts'

export const getAppleContainerHostDatabase = (repositoryRoot: string) => {
  const directory = realpathSync(getRuntimeProfileDataRoot({profileName: 'primary'}))
  const databasePath = join(directory, 'forska.duckdb')
  const assetsDirectory = realpathSync(join(repositoryRoot, 'assets'))
  if (!statSync(databasePath).isFile()) {
    throw new Error(`Expected an existing database file: ${databasePath}`)
  }
  if (!statSync(assetsDirectory).isDirectory()) {
    throw new Error(`Expected an assets directory: ${assetsDirectory}`)
  }
  if (
    [directory, assetsDirectory].some((path) => {
      return path.includes(':')
    })
  ) {
    throw new Error('Apple container bind-mount paths cannot contain a colon')
  }
  return {directory, databasePath, assetsDirectory}
}

export const assertAppleContainerDatabaseHasNoLocks = (databasePath: string) => {
  const lockPaths = [
    `${databasePath}.duckdb-owner.lock`,
    `${databasePath}.writer.lock`,
    join(dirname(databasePath), 'judge-worker-journals', 'primary-judge-worker.sqlite.lock'),
  ]
  const existingLock = lockPaths.find(existsSync)
  if (existingLock) {
    throw new Error(`Stop the host DB owner cleanly before using --host-db; lock exists: ${existingLock}`)
  }
}

export const assertAppleContainerDatabaseIsIdle = (databasePath: string) => {
  assertAppleContainerDatabaseHasNoLocks(databasePath)
  const lsof = globalThis.Bun.which('lsof')
  if (!lsof) {
    throw new Error('lsof is required to check host database use before starting --host-db')
  }
  const journalPath = join(dirname(databasePath), 'judge-worker-journals', 'primary-judge-worker.sqlite')
  const paths = [databasePath, `${databasePath}.wal`, journalPath, `${journalPath}-wal`, `${journalPath}-shm`].filter(
    existsSync,
  )
  const result = globalThis.Bun.spawnSync([lsof, '-t', '--', ...paths], {stdout: 'pipe', stderr: 'pipe'})
  if (result.exitCode !== 1 || result.stdout.toString().trim() || result.stderr.toString().trim()) {
    throw new Error(
      'The host database is open, or its usage could not be verified. Stop the host app before --host-db.',
    )
  }
}
