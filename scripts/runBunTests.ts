const ignoredPrefixes = ['node_modules/', 'dist/', '.git/', 'desktopBuild/', 'desktopArtifacts/']

const isIgnoredPath = (filePath: string) => {
  return ignoredPrefixes.some((prefix) => {
    return filePath.startsWith(prefix)
  })
}

const getTestFiles = async () => {
  const patterns = ['**/*.test.ts', '**/*.test.tsx']
  const fileSets = await Promise.all(
    patterns.map(async (pattern) => {
      return Array.fromAsync(new Bun.Glob(pattern).scan({cwd: process.cwd(), onlyFiles: true}))
    }),
  )

  return Array.from(new Set(fileSets.flat()))
    .filter((filePath) => {
      return !isIgnoredPath(filePath)
    })
    .sort((left, right) => {
      return left.localeCompare(right)
    })
}

const runBunTest = (files: string[]) => {
  if (files.length === 0) {
    return
  }

  const fileArgs = files.map((filePath) => {
    return filePath.startsWith('./') ? filePath : `./${filePath}`
  })

  const result = Bun.spawnSync(['bun', 'test', ...fileArgs], {
    cwd: process.cwd(),
    env: process.env,
    stderr: 'inherit',
    stdout: 'inherit',
  })

  if (result.exitCode !== 0) {
    process.exit(result.exitCode ?? 1)
  }
}

const main = async () => {
  const args = process.argv.slice(2)

  if (args.length > 0) {
    runBunTest(args)
    return
  }

  const testFiles = await getTestFiles()
  testFiles.forEach((filePath) => {
    runBunTest([filePath])
  })
}

await main()
