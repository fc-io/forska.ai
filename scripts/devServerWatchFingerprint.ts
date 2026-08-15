import {createHash} from 'node:crypto'
import {lstat, readdir} from 'node:fs/promises'
import {join} from 'node:path'

const isMissingFileError = (error: unknown) => {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

const getPathFingerprintEntries = async (rootPath: string, currentPath = rootPath): Promise<readonly string[]> => {
  try {
    const pathStat = await lstat(currentPath)

    if (!pathStat.isDirectory()) {
      return [`file:${currentPath}:${pathStat.size}:${pathStat.mtimeMs}`]
    }

    const childNames = (await readdir(currentPath)).sort((left, right) => {
      return left.localeCompare(right)
    })
    const childEntries = await Promise.all(
      childNames.map((childName) => {
        return getPathFingerprintEntries(rootPath, join(currentPath, childName))
      }),
    )

    return [`directory:${currentPath}`, ...childEntries.flat()]
  } catch (error) {
    if (!isMissingFileError(error)) {
      throw error
    }

    return currentPath === rootPath ? [`missing:${rootPath}`] : []
  }
}

export const getDevServerWatchFingerprint = async (watchedPaths: readonly string[]) => {
  const fingerprintEntries = await Promise.all(
    watchedPaths.map((watchedPath) => {
      return getPathFingerprintEntries(watchedPath)
    }),
  )

  return createHash('sha256').update(fingerprintEntries.flat().join('\n')).digest('hex')
}
