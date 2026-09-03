import {resolve} from 'node:path'

const ignoredPrefixes = ['node_modules/', 'dist/', '.git/', 'desktopBuild/', 'desktopArtifacts/']
export const bunTestProcessTimeoutMs = 10 * 60_000

export const normalizeBunTestFilePath = (filePath: string) => {
  return filePath.replaceAll('\\', '/')
}

export const isIgnoredBunTestFilePath = (filePath: string) => {
  const normalizedFilePath = normalizeBunTestFilePath(filePath)

  return ignoredPrefixes.some((prefix) => {
    return normalizedFilePath.startsWith(prefix)
  })
}

const getTestFiles = async () => {
  const patterns = ['**/*.test.ts', '**/*.test.tsx']
  const fileSets = await Promise.all(
    patterns.map(async (pattern) => {
      return Array.fromAsync(new globalThis.Bun.Glob(pattern).scan({cwd: process.cwd(), onlyFiles: true}))
    }),
  )

  return Array.from(new Set(fileSets.flat().map(normalizeBunTestFilePath)))
    .filter((filePath) => {
      return !isIgnoredBunTestFilePath(filePath)
    })
    .sort((left, right) => {
      return left.localeCompare(right)
    })
}

export const getBunTestCommand = (files: string[], cwd = process.cwd()) => {
  const fileArgs = files.map((filePath) => {
    return resolve(cwd, filePath)
  })

  return ['bun', 'test', ...fileArgs]
}

const runBunTest = async (files: string[]) => {
  if (files.length === 0) {
    return
  }

  const testProcess = globalThis.Bun.spawn(getBunTestCommand(files), {
    cwd: process.cwd(),
    env: process.env,
    stderr: 'inherit',
    stdout: 'inherit',
  })
  let timedOut = false
  const timeout = setTimeout(() => {
    timedOut = true

    try {
      testProcess.kill('SIGKILL')
    } catch {
      // The process may have exited between the timeout and the kill attempt.
    }
  }, bunTestProcessTimeoutMs)
  timeout.unref?.()

  const exitCode = await testProcess.exited
  clearTimeout(timeout)

  if (timedOut) {
    console.error(`Bun test process exceeded ${bunTestProcessTimeoutMs}ms: ${files.join(', ')}`)
    process.exit(1)
  }

  if (exitCode !== 0) {
    process.exit(exitCode ?? 1)
  }
}

const main = async () => {
  const args = process.argv.slice(2)

  if (args.length > 0) {
    await runBunTest(args)
    return
  }

  const testFiles = await getTestFiles()
  for (const filePath of testFiles) {
    await runBunTest([filePath])
  }
}

if (import.meta.main) {
  await main()
}
