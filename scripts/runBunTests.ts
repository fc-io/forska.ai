const isolatedTestFiles = new Set([
  'src/agent/importerStoreEntries.test.ts',
  'src/agent/judge/judgeStoreTokenUse.test.ts',
  'src/server/cron/judgmentsJobs/judgmentsJobsAddToQueue.test.ts',
  'src/server/cron/judgmentsJobs/judgmentsJobsCleanupStale.test.ts',
  'src/server/cron/judgmentsJobs/judgmentJobSqliteOutboxImport.test.ts',
  'src/server/cron/judgmentsJobs/judgmentJobSqliteService.test.ts',
  'src/server/cron/judgmentsJobs/judgmentsRequestRuntime.test.ts',
  'src/server/cron/judgmentsJobs/judgmentsJobsSendToLLM/getAndUpdateReadyPrompts.test.ts',
  'src/server/cron/judgmentsJobs/requeueAbandonedSentPrompts.test.ts',
  'src/server/providers/adapters/createOpenAICompatibleAdapter.test.ts',
  'src/server/providers/adapters/directAdapters.test.ts',
  'src/server/providers/providerAuthService.test.ts',
  'src/server/providers/providerRuntimeDetector.test.ts',
  'src/server/providers/providerRuntimeModelGuard.test.ts',
  'src/server/routes/ApiProxyRoutes.retry.test.ts',
  'src/server/routes/ComparisonProjectsRoutes.rollback.test.ts',
  'src/server/routes/HumanAssessmentRoutes/humanAssessmentRoutesPostInit.test.ts',
  'src/server/routes/HumanAssessmentRoutes/humanAssessmentRoutesPostSubmit.test.ts',
  'src/server/routes/JudgmentsJobsRoutes.test.ts',
  'src/server/routes/ProviderConnectionsRoutes.test.ts',
  'src/server/routes/ProviderModelsRoutes.test.ts',
  'src/server/routes/SubprojectsRoutes.rollback.test.ts',
  'src/server/routes/projectsRoutes/projectAccessGuard.test.ts',
  'src/server/routes/projectsRoutes/projectsRoutesGetReviewsWarnings.test.ts',
  'src/server/routes/projectsRoutes/projectsRoutesOlapParity.test.ts',
  'src/server/routes/projectsRoutes/projectsRoutesPostArticleReviewDetails.test.ts',
  'src/server/services/insertArticlesIntoProject.test.ts',
  'src/server/services/structuredFileImportService.test.ts',
  'src/services/olap/duckdbOlap.test.ts',
  'src/services/olap/duckdbRunnerAppDatabase.test.ts',
  'src/utils/llmStatusQuery.test.ts',
])

const ignoredPrefixes = ['node_modules/', 'dist/', '.git/']

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

  const result = Bun.spawnSync(['bun', 'test', ...files], {
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
  const sharedTestFiles = testFiles.filter((filePath) => {
    return !isolatedTestFiles.has(filePath)
  })
  const isolatedFilesInRepo = [...isolatedTestFiles].filter((filePath) => {
    return testFiles.includes(filePath)
  })

  runBunTest(sharedTestFiles)

  isolatedFilesInRepo.forEach((filePath) => {
    runBunTest([filePath])
  })
}

await main()
