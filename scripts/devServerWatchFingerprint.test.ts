import {mkdir, mkdtemp, rm, utimes, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

import {expect, test} from 'bun:test'

import {getDevServerWatchFingerprint} from './devServerWatchFingerprint.ts'

test('dev server watch fingerprint ignores transient paths that leave no source change', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'forska-dev-watch-fingerprint-'))
  const sourceDirectory = join(directory, 'src')
  const sourcePath = join(sourceDirectory, 'server.ts')
  const transientPath = join(sourceDirectory, 'server.ts.tmp')

  try {
    await mkdir(sourceDirectory)
    await writeFile(sourcePath, 'export const value = 1\n')
    const before = await getDevServerWatchFingerprint([sourceDirectory])

    await writeFile(transientPath, 'temporary')
    await rm(transientPath)

    expect(await getDevServerWatchFingerprint([sourceDirectory])).toBe(before)
  } finally {
    await rm(directory, {force: true, recursive: true})
  }
})

test('dev server watch fingerprint detects lasting source changes and deletions', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'forska-dev-watch-fingerprint-'))
  const sourceDirectory = join(directory, 'src')
  const sourcePath = join(sourceDirectory, 'server.ts')

  try {
    await mkdir(sourceDirectory)
    await writeFile(sourcePath, 'export const value = 1\n')
    const before = await getDevServerWatchFingerprint([sourceDirectory])

    await writeFile(sourcePath, 'export const value = 2\n')
    await utimes(sourcePath, new Date(), new Date(Date.now() + 1_000))
    const afterWrite = await getDevServerWatchFingerprint([sourceDirectory])
    await rm(sourcePath)
    const afterDelete = await getDevServerWatchFingerprint([sourceDirectory])

    expect(afterWrite).not.toBe(before)
    expect(afterDelete).not.toBe(afterWrite)
  } finally {
    await rm(directory, {force: true, recursive: true})
  }
})
