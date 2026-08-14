import {tmpdir} from 'node:os'
import {posix, win32} from 'node:path'

type PathPlatform = 'posix' | 'win32'

type PlaywrightRemovalPathOptions = {platform?: PathPlatform; tempDirectory?: string}

const getRuntimePathPlatform = (): PathPlatform => {
  return process.platform === 'win32' ? 'win32' : 'posix'
}

export const assertSafePlaywrightRemovalPath = (candidatePath: string, options: PlaywrightRemovalPathOptions = {}) => {
  const platform = options.platform ?? getRuntimePathPlatform()
  const pathModule = platform === 'win32' ? win32 : posix
  const resolvedPath = pathModule.resolve(candidatePath)
  const resolvedTempDirectory = pathModule.resolve(options.tempDirectory ?? tmpdir())
  const comparisonPath = platform === 'win32' ? resolvedPath.toLowerCase() : resolvedPath
  const comparisonTempDirectory = platform === 'win32' ? resolvedTempDirectory.toLowerCase() : resolvedTempDirectory
  const relativePath = pathModule.relative(comparisonTempDirectory, comparisonPath)
  const isTempDescendant =
    relativePath !== ''
    && relativePath !== '..'
    && !relativePath.startsWith(`..${pathModule.sep}`)
    && !pathModule.isAbsolute(relativePath)

  if (!isTempDescendant) {
    throw new Error(`Refusing to remove Playwright path outside the OS temp directory: ${resolvedPath}`)
  }

  return resolvedPath
}
