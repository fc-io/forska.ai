import {existsSync, mkdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs'
import {join} from 'node:path'

import {DuckDBConnection, DuckDBInstance} from '@duckdb/node-api'

import {reviewServingBenchmarkOverlapWorkloadDefinition} from './reviewServingBenchmark.ts'

export const reviewServingSyntheticBenchmarkFixtureVersion = 'reviewServingSynthetic.v1'
export const reviewServingSyntheticBenchmarkDefaultSeed = 732_451
export const reviewServingSyntheticBenchmarkScales = ['small', 'medium', 'release'] as const

export type ReviewServingSyntheticBenchmarkScale = (typeof reviewServingSyntheticBenchmarkScales)[number]

export type ReviewServingSyntheticFixtureManifest = {
  articleCount: number
  articlePromptOverlapRows: number
  duckdbMemoryLimit: string
  fixtureVersion: string
  holdout: boolean
  promptCount: number
  scale: ReviewServingSyntheticBenchmarkScale
  seed: number
}

export type ReviewServingSyntheticFixture = {
  connection: DuckDBConnection
  duckdbInstance: DuckDBInstance
  duckdbPath: string
  manifest: ReviewServingSyntheticFixtureManifest
  rootDirectory: string
}

export type ReviewServingSyntheticBenchmarkMode = 'check' | 'measure'

export type ReviewServingSyntheticBenchmarkOperationSample = {
  diagnostics: Record<string, number>
  latencyMs: number
  memoryRssBytes: number
  operationKey: string
  rowsReturned: number
  rowsScanned: number
  sampleIndex: number
  tempSpillBytes: number
  warmup: boolean
  writerBatchCount: number
  writerRowsPerBatch: number
}

export type ReviewServingSyntheticBenchmarkOperationMetrics = {
  diagnostics: Record<string, number>
  operationKey: string
  p50LatencyMs: number
  p95LatencyMs: number
  p99LatencyMs: number
  rowsReturned: number
  rowsScanned: number
  sampleCount: number
  tempSpillBytes: number
  writerBatchCount: number
  writerRowsPerBatch: number
}

export type ReviewServingSyntheticBenchmarkViolation = {
  actual: number | string
  budget: number | string
  metric: string
  operationKey?: string
}

export type ReviewServingSyntheticBenchmarkArtifact = {
  artifactPath: string
  budgetProfile: 'medium-pr' | 'release-manual'
  command: string
  createdAt: string
  duckdbVersion: string
  fixture: ReviewServingSyntheticFixtureManifest
  gitSha: string
  mode: ReviewServingSyntheticBenchmarkMode
  operationMetrics: readonly ReviewServingSyntheticBenchmarkOperationMetrics[]
  platform: {arch: string; bunVersion: string; os: string}
  samples: readonly ReviewServingSyntheticBenchmarkOperationSample[]
  targetMetric: string | null
  targetOperation: string | null
  totals: {
    peakRssBytes: number
    p95LatencyMs: number
    p99LatencyMs: number
    rowsReturned: number
    rowsScanned: number
    rssGrowthBytes: number
    tempSpillBytes: number
    writerBatchCount: number
  }
  violations: readonly ReviewServingSyntheticBenchmarkViolation[]
  workloadKey: string
}

export type RunReviewServingSyntheticBenchmarkInput = {
  artifactDirectory?: string
  command: string
  duckdbMemoryLimit: string
  holdout?: boolean
  mode: ReviewServingSyntheticBenchmarkMode
  scale: ReviewServingSyntheticBenchmarkScale
  seed?: number
  targetMetric?: string | null
  targetOperation?: string | null
}

export type ReviewServingSyntheticBenchmarkCompareResult = {
  configDrift: readonly string[]
  deltas: readonly {
    after: ReviewServingSyntheticBenchmarkOperationMetrics
    before: ReviewServingSyntheticBenchmarkOperationMetrics
    operationKey: string
    p95LatencyDeltaMs: number
    p99LatencyDeltaMs: number
    rowsReturnedDelta: number
    rowsScannedDelta: number
    tempSpillDeltaBytes: number
    writerBatchCountDelta: number
  }[]
  nonTargetRegressions: readonly ReviewServingSyntheticBenchmarkViolation[]
}

const scaleArticleCounts = {
  small: 1_000,
  medium: 10_000,
  release: 100_000,
} as const satisfies Record<ReviewServingSyntheticBenchmarkScale, number>

const syntheticBenchmarkBudgets = {
  check: {
    maxOperationP95LatencyMs: 2_000,
    maxOperationP99LatencyMs: 5_000,
    maxPeakRssBytes: 2 * 1024 ** 3,
    maxRowsReturned: 10_000,
    maxRowsScanned: 250_000,
    maxRssGrowthBytes: 512 * 1024 ** 2,
    maxTempSpillBytes: 0,
    maxWriterBatchCount: 16,
    maxWriterRowsPerBatch: 100_000,
  },
  release: {
    maxOperationP95LatencyMs: 2_000,
    maxOperationP99LatencyMs: 5_000,
    maxPeakRssBytes: 20 * 1024 ** 3,
    maxRowsReturned: 10_000,
    maxRowsScanned: 2_500_000,
    maxRssGrowthBytes: 4 * 1024 ** 3,
    maxTempSpillBytes: 0,
    maxWriterBatchCount: 64,
    maxWriterRowsPerBatch: 1_000_000,
  },
} as const

export const getReviewServingSyntheticBenchmarkArticleCount = (scale: ReviewServingSyntheticBenchmarkScale) => {
  return scaleArticleCounts[scale]
}

export const getReviewServingSyntheticFixtureManifest = ({
  duckdbMemoryLimit,
  holdout = false,
  scale,
  seed,
}: {
  duckdbMemoryLimit: string
  holdout?: boolean
  scale: ReviewServingSyntheticBenchmarkScale
  seed: number
}): ReviewServingSyntheticFixtureManifest => {
  const articleCount = getReviewServingSyntheticBenchmarkArticleCount(scale)
  const promptCount = 7

  return {
    articleCount,
    articlePromptOverlapRows: articleCount * promptCount,
    duckdbMemoryLimit,
    fixtureVersion: reviewServingSyntheticBenchmarkFixtureVersion,
    holdout,
    promptCount,
    scale,
    seed,
  }
}

const removeFileIfExists = (filePath: string) => {
  if (existsSync(filePath)) {
    rmSync(filePath, {force: true, recursive: true})
  }
}

export const cleanupReviewServingSyntheticFixture = (fixture: Pick<ReviewServingSyntheticFixture, 'duckdbPath' | 'rootDirectory'>) => {
  removeFileIfExists(fixture.duckdbPath)
  removeFileIfExists(`${fixture.duckdbPath}.wal`)
  removeFileIfExists(`${fixture.duckdbPath}.duckdb-owner.lock`)
  removeFileIfExists(`${fixture.duckdbPath}.duckdb-owner.history.json`)
  removeFileIfExists(fixture.rootDirectory)
}

const getBenchmarkRootDirectory = () => {
  const rootDirectory = join(process.cwd(), '.tmp', 'benchmarks')
  mkdirSync(rootDirectory, {recursive: true})

  return rootDirectory
}

const getFixtureRootDirectory = (scale: ReviewServingSyntheticBenchmarkScale, seed: number) => {
  const rootDirectory = join(getBenchmarkRootDirectory(), `review-serving-${scale}-${seed}-${Date.now()}`)
  mkdirSync(rootDirectory, {recursive: true})

  return rootDirectory
}

const seedReviewServingSyntheticSchema = async (
  connection: DuckDBConnection,
  manifest: ReviewServingSyntheticFixtureManifest,
) => {
  await connection.run(`
    CREATE TABLE article (
      article_id INTEGER PRIMARY KEY,
      title VARCHAR NOT NULL,
      year INTEGER NOT NULL,
      selected BOOLEAN NOT NULL
    );
    CREATE TABLE prompt_overlap (
      article_id INTEGER NOT NULL,
      prompt_id INTEGER NOT NULL,
      llm_status VARCHAR NOT NULL,
      human_status VARCHAR NOT NULL,
      queue_kind VARCHAR NOT NULL,
      token_prefix VARCHAR NOT NULL
    );
    CREATE TABLE filter_option (
      prompt_id INTEGER NOT NULL,
      year INTEGER NOT NULL,
      total INTEGER NOT NULL
    );
    CREATE TABLE writer_diagnostic (
      table_name VARCHAR NOT NULL,
      batch_count INTEGER NOT NULL,
      rows_per_batch INTEGER NOT NULL,
      rows_written INTEGER NOT NULL
    );
  `)
  await connection.run(`
    INSERT INTO article
    SELECT
      article_id,
      'Synthetic review article ' || article_id || ' seed ${manifest.seed}' AS title,
      2000 + ((article_id + ${manifest.seed}) % 25) AS year,
      article_id % 3 <> 0 AS selected
    FROM range(1, ${manifest.articleCount + 1}) AS source(article_id);
  `)
  await connection.run(`
    INSERT INTO prompt_overlap
    SELECT
      article.article_id,
      prompt.prompt_id,
      CASE WHEN (article.article_id + prompt.prompt_id + ${manifest.seed}) % 5 = 0 THEN 'unassessed' ELSE 'assessed' END AS llm_status,
      CASE WHEN (article.article_id + prompt.prompt_id + ${manifest.seed}) % 7 = 0 THEN 'conflict' ELSE 'reviewed' END AS human_status,
      CASE WHEN (article.article_id + prompt.prompt_id) % 11 = 0 THEN 'priority' ELSE 'normal' END AS queue_kind,
      lower(substr(article.title, 1, 3)) AS token_prefix
    FROM article
    CROSS JOIN range(1, ${manifest.promptCount + 1}) AS prompt(prompt_id);
  `)
  await connection.run(`
    INSERT INTO filter_option
    SELECT prompt_id, year, count(*)::INTEGER AS total
    FROM prompt_overlap
    INNER JOIN article USING (article_id)
    GROUP BY prompt_id, year;
  `)
  await connection.run(`
    INSERT INTO writer_diagnostic VALUES
      ('article', 4, ${Math.ceil(manifest.articleCount / 4)}, ${manifest.articleCount}),
      ('prompt_overlap', 7, ${manifest.articleCount}, ${manifest.articlePromptOverlapRows}),
      ('filter_option', 1, ${manifest.promptCount * 25}, ${manifest.promptCount * 25});
  `)
}

export const createReviewServingSyntheticFixture = async ({
  duckdbMemoryLimit,
  holdout = false,
  scale,
  seed = reviewServingSyntheticBenchmarkDefaultSeed,
}: {
  duckdbMemoryLimit: string
  holdout?: boolean
  scale: ReviewServingSyntheticBenchmarkScale
  seed?: number
}): Promise<ReviewServingSyntheticFixture> => {
  const manifest = getReviewServingSyntheticFixtureManifest({duckdbMemoryLimit, holdout, scale, seed})
  const rootDirectory = getFixtureRootDirectory(scale, seed)
  const duckdbPath = join(rootDirectory, 'synthetic.duckdb')
  const duckdbInstance = await DuckDBInstance.create(duckdbPath, {memory_limit: duckdbMemoryLimit})
  const connection = await duckdbInstance.connect()

  await seedReviewServingSyntheticSchema(connection, manifest)

  return {connection, duckdbInstance, duckdbPath, manifest, rootDirectory}
}

export const closeReviewServingSyntheticFixture = (fixture: ReviewServingSyntheticFixture) => {
  fixture.connection.closeSync()
  fixture.duckdbInstance.closeSync()
}

const getPercentileMetric = (values: readonly number[], percentile: number) => {
  const sortedValues = [...values].sort((left, right) => {
    return left - right
  })
  const index = Math.min(sortedValues.length - 1, Math.max(0, Math.ceil(sortedValues.length * percentile) - 1))

  return sortedValues.length === 0 ? 0 : (sortedValues[index] ?? 0)
}

const getTotal = (values: readonly number[]) => {
  return values.reduce((total, value) => {
    return total + value
  }, 0)
}

const sampleRssBytes = () => {
  return typeof process.memoryUsage === 'function' ? process.memoryUsage().rss : 0
}

const getNumberFromRow = (row: Record<string, unknown>, key: string) => {
  return Number(row[key] ?? 0)
}

const runJsonQuery = async (connection: DuckDBConnection, sql: string) => {
  const reader = await connection.runAndReadAll(sql)

  return reader.getRowObjectsJson() as Array<Record<string, unknown>>
}

const getOperationSql = (operationKey: string, sampleIndex: number) => {
  const promptId = (sampleIndex % 7) + 1
  const offset = sampleIndex * 17

  if (operationKey.includes('Count')) {
    return `
      SELECT COUNT(*) AS rowsReturned, COUNT(*) AS rowsScanned, 1 AS resultRows
      FROM prompt_overlap
      WHERE prompt_id = ${promptId}
    `
  }

  if (operationKey.includes('Facet') || operationKey.includes('FilterOptions')) {
    return `
      SELECT COUNT(*) AS rowsReturned, SUM(total) AS rowsScanned, COUNT(*) AS resultRows
      FROM filter_option
      WHERE prompt_id = ${promptId}
    `
  }

  if (operationKey.includes('Job') || operationKey.includes('SearchJob')) {
    return `
      SELECT COUNT(*) AS rowsReturned, COUNT(*) AS rowsScanned, 1 AS resultRows
      FROM article
      WHERE selected = true AND article_id % 97 = ${sampleIndex % 97}
    `
  }

  if (operationKey.includes('Search')) {
    return `
      SELECT LEAST(COUNT(*), 50) AS rowsReturned, COUNT(*) AS rowsScanned, LEAST(COUNT(*), 50) AS resultRows
      FROM article
      WHERE lower(title) LIKE 'syn%'
      LIMIT 50
    `
  }

  if (operationKey.includes('Checkpoint')) {
    return `
      SELECT COUNT(*) AS rowsReturned, COUNT(*) AS rowsScanned, 1 AS resultRows
      FROM writer_diagnostic
    `
  }

  return `
    SELECT COUNT(*) AS rowsReturned, COUNT(*) AS rowsScanned, COUNT(*) AS resultRows
    FROM (
      SELECT article.article_id
      FROM prompt_overlap
      INNER JOIN article USING (article_id)
      WHERE prompt_overlap.prompt_id = ${promptId}
      ORDER BY article.article_id
      LIMIT 100 OFFSET ${offset}
    ) selected_rows
  `
}

const getWriterDiagnostics = async (connection: DuckDBConnection) => {
  const [row] = await runJsonQuery(connection, `
    SELECT SUM(batch_count) AS batchCount, MAX(rows_per_batch) AS rowsPerBatch
    FROM writer_diagnostic
  `)

  return {batchCount: getNumberFromRow(row ?? {}, 'batchCount'), rowsPerBatch: getNumberFromRow(row ?? {}, 'rowsPerBatch')}
}

const runOperationSample = async ({
  connection,
  operationKey,
  sampleIndex,
  warmup,
}: {
  connection: DuckDBConnection
  operationKey: string
  sampleIndex: number
  warmup: boolean
}): Promise<ReviewServingSyntheticBenchmarkOperationSample> => {
  const writerDiagnostics = await getWriterDiagnostics(connection)
  const startedAt = performance.now()
  const [row] = await runJsonQuery(connection, getOperationSql(operationKey, sampleIndex))
  const latencyMs = Number((performance.now() - startedAt).toFixed(3))
  const rowsReturned = getNumberFromRow(row ?? {}, 'resultRows')
  const rowsScanned = getNumberFromRow(row ?? {}, 'rowsScanned')

  return {
    diagnostics: {queryMs: latencyMs},
    latencyMs,
    memoryRssBytes: sampleRssBytes(),
    operationKey,
    rowsReturned,
    rowsScanned,
    sampleIndex,
    tempSpillBytes: 0,
    warmup,
    writerBatchCount: writerDiagnostics.batchCount,
    writerRowsPerBatch: writerDiagnostics.rowsPerBatch,
  }
}

const getOperationMetrics = (
  samples: readonly ReviewServingSyntheticBenchmarkOperationSample[],
): ReviewServingSyntheticBenchmarkOperationMetrics[] => {
  const operationKeys = [
    ...new Set(
      samples.map((sample) => {
        return sample.operationKey
      }),
    ),
  ]

  return operationKeys.map((operationKey) => {
    const operationSamples = samples.filter((sample) => {
      return sample.operationKey === operationKey && !sample.warmup
    })
    const latencies = operationSamples.map((sample) => {
      return sample.latencyMs
    })

    return {
      diagnostics: {sampledQueryMs: getTotal(latencies)},
      operationKey,
      p50LatencyMs: getPercentileMetric(latencies, 0.5),
      p95LatencyMs: getPercentileMetric(latencies, 0.95),
      p99LatencyMs: getPercentileMetric(latencies, 0.99),
      rowsReturned: getTotal(
        operationSamples.map((sample) => {
          return sample.rowsReturned
        }),
      ),
      rowsScanned: getTotal(
        operationSamples.map((sample) => {
          return sample.rowsScanned
        }),
      ),
      sampleCount: operationSamples.length,
      tempSpillBytes: getTotal(
        operationSamples.map((sample) => {
          return sample.tempSpillBytes
        }),
      ),
      writerBatchCount: Math.max(
        ...operationSamples.map((sample) => {
          return sample.writerBatchCount
        }),
      ),
      writerRowsPerBatch: Math.max(
        ...operationSamples.map((sample) => {
          return sample.writerRowsPerBatch
        }),
      ),
    }
  })
}

const getBudgetProfile = (scale: ReviewServingSyntheticBenchmarkScale) => {
  return scale === 'release' ? 'release-manual' : 'medium-pr'
}

const getBudgetViolations = ({
  artifact,
  startRssBytes,
}: {
  artifact: Omit<ReviewServingSyntheticBenchmarkArtifact, 'artifactPath' | 'violations'>
  startRssBytes: number
}): ReviewServingSyntheticBenchmarkViolation[] => {
  const budgets = artifact.fixture.scale === 'release' ? syntheticBenchmarkBudgets.release : syntheticBenchmarkBudgets.check
  const rssViolations = [
    {actual: artifact.totals.peakRssBytes, budget: budgets.maxPeakRssBytes, metric: 'rss.peak'},
    {actual: artifact.totals.peakRssBytes - startRssBytes, budget: budgets.maxRssGrowthBytes, metric: 'rss.growth'},
    {actual: artifact.totals.tempSpillBytes, budget: budgets.maxTempSpillBytes, metric: 'temp.spillBytes'},
    {actual: artifact.totals.writerBatchCount, budget: budgets.maxWriterBatchCount, metric: 'writer.batchCount'},
  ].filter((violation) => {
    return violation.actual > violation.budget
  })
  const operationViolations = artifact.operationMetrics.flatMap((metrics) => {
    return [
      {actual: metrics.rowsScanned, budget: budgets.maxRowsScanned, metric: 'rows.scanned', operationKey: metrics.operationKey},
      {actual: metrics.rowsReturned, budget: budgets.maxRowsReturned, metric: 'rows.returned', operationKey: metrics.operationKey},
      {actual: metrics.tempSpillBytes, budget: budgets.maxTempSpillBytes, metric: 'temp.spillBytes', operationKey: metrics.operationKey},
      {
        actual: metrics.writerRowsPerBatch,
        budget: budgets.maxWriterRowsPerBatch,
        metric: 'writer.rowsPerBatch',
        operationKey: metrics.operationKey,
      },
      {
        actual: metrics.p95LatencyMs,
        budget: budgets.maxOperationP95LatencyMs,
        metric: 'latency.p95Ms',
        operationKey: metrics.operationKey,
      },
      {
        actual: metrics.p99LatencyMs,
        budget: budgets.maxOperationP99LatencyMs,
        metric: 'latency.p99Ms',
        operationKey: metrics.operationKey,
      },
    ].filter((violation) => {
      return violation.actual > violation.budget
    })
  })

  return [...rssViolations, ...operationViolations]
}

const getGitSha = () => {
  const result = globalThis.Bun.spawnSync(['git', 'rev-parse', 'HEAD'], {cwd: process.cwd()})

  return result.exitCode === 0 ? result.stdout.toString().trim() : 'unknown'
}

const getDuckdbVersion = async (connection: DuckDBConnection) => {
  const [row] = await runJsonQuery(connection, 'SELECT version() AS version')

  return String(row?.version ?? 'unknown')
}

const writeBenchmarkArtifact = (
  artifactDirectory: string | undefined,
  artifact: Omit<ReviewServingSyntheticBenchmarkArtifact, 'artifactPath'>,
) => {
  const directory = artifactDirectory ?? getBenchmarkRootDirectory()
  mkdirSync(directory, {recursive: true})
  const artifactPath = join(
    directory,
    `review-serving-synthetic-${artifact.fixture.scale}-${artifact.mode}-${artifact.fixture.seed}-${Date.now()}.json`,
  )
  const artifactWithPath = {...artifact, artifactPath}

  writeFileSync(artifactPath, `${JSON.stringify(artifactWithPath, null, 2)}\n`)

  return artifactWithPath
}

export const runReviewServingSyntheticBenchmark = async (
  input: RunReviewServingSyntheticBenchmarkInput,
): Promise<ReviewServingSyntheticBenchmarkArtifact> => {
  const fixture = await createReviewServingSyntheticFixture(input)
  const startRssBytes = sampleRssBytes()

  try {
    const operationKeys = reviewServingBenchmarkOverlapWorkloadDefinition.operations.map((operation) => {
      return operation.key
    })
    const warmupSamples = await Promise.all(
      operationKeys.map((operationKey) => {
        return runOperationSample({connection: fixture.connection, operationKey, sampleIndex: 0, warmup: true})
      }),
    )
    const measuredSamples = await Promise.all(
      operationKeys.flatMap((operationKey) => {
        return [1, 2, 3].map((sampleIndex) => {
          return runOperationSample({connection: fixture.connection, operationKey, sampleIndex, warmup: false})
        })
      }),
    )
    const samples = [...warmupSamples, ...measuredSamples]
    const measuredOnlySamples = samples.filter((sample) => {
      return !sample.warmup
    })
    const operationMetrics = getOperationMetrics(samples)
    const latencyValues = measuredOnlySamples.map((sample) => {
      return sample.latencyMs
    })
    const rssValues = [
      startRssBytes,
      ...samples.map((sample) => {
        return sample.memoryRssBytes
      }),
    ]
    const artifactWithoutViolations = {
      budgetProfile: getBudgetProfile(input.scale),
      command: input.command,
      createdAt: new Date().toISOString(),
      duckdbVersion: await getDuckdbVersion(fixture.connection),
      fixture: fixture.manifest,
      gitSha: getGitSha(),
      mode: input.mode,
      operationMetrics,
      platform: {arch: process.arch, bunVersion: Bun.version, os: process.platform},
      samples,
      targetMetric: input.targetMetric ?? null,
      targetOperation: input.targetOperation ?? null,
      totals: {
        peakRssBytes: Math.max(...rssValues),
        p95LatencyMs: getPercentileMetric(latencyValues, 0.95),
        p99LatencyMs: getPercentileMetric(latencyValues, 0.99),
        rowsReturned: getTotal(
          measuredOnlySamples.map((sample) => {
            return sample.rowsReturned
          }),
        ),
        rowsScanned: getTotal(
          measuredOnlySamples.map((sample) => {
            return sample.rowsScanned
          }),
        ),
        rssGrowthBytes: Math.max(...rssValues) - startRssBytes,
        tempSpillBytes: getTotal(
          measuredOnlySamples.map((sample) => {
            return sample.tempSpillBytes
          }),
        ),
        writerBatchCount: Math.max(
          ...measuredOnlySamples.map((sample) => {
            return sample.writerBatchCount
          }),
        ),
      },
      workloadKey: reviewServingBenchmarkOverlapWorkloadDefinition.key,
    } satisfies Omit<ReviewServingSyntheticBenchmarkArtifact, 'artifactPath' | 'violations'>
    const violations = getBudgetViolations({artifact: artifactWithoutViolations, startRssBytes})
    const artifact = writeBenchmarkArtifact(input.artifactDirectory, {...artifactWithoutViolations, violations})

    if (input.mode === 'check' && violations.length > 0) {
      throw new Error(`Review-serving synthetic benchmark budget violations: ${JSON.stringify(violations)}`)
    }

    return artifact
  } finally {
    closeReviewServingSyntheticFixture(fixture)
    cleanupReviewServingSyntheticFixture(fixture)
  }
}

export const readReviewServingSyntheticBenchmarkArtifact = (artifactPath: string) => {
  return JSON.parse(readFileSync(artifactPath, 'utf8')) as ReviewServingSyntheticBenchmarkArtifact
}

const benchmarkCriticalArtifactFields = [
  'workloadKey',
  'budgetProfile',
  'fixture.fixtureVersion',
  'fixture.scale',
  'fixture.seed',
  'fixture.promptCount',
  'fixture.articleCount',
  'fixture.articlePromptOverlapRows',
  'fixture.duckdbMemoryLimit',
  'fixture.holdout',
] as const

const getArtifactFieldValue = (artifact: ReviewServingSyntheticBenchmarkArtifact, field: string): unknown => {
  return field.split('.').reduce<unknown>((value, key) => {
    return typeof value === 'object' && value !== null ? (value as Record<string, unknown>)[key] : undefined
  }, artifact)
}

const getConfigDrift = (
  before: ReviewServingSyntheticBenchmarkArtifact,
  after: ReviewServingSyntheticBenchmarkArtifact,
) => {
  const operationKeysBefore = before.operationMetrics.map((operation) => {
    return operation.operationKey
  })
  const operationKeysAfter = after.operationMetrics.map((operation) => {
    return operation.operationKey
  })
  const fieldDrift = benchmarkCriticalArtifactFields.filter((field) => {
    return getArtifactFieldValue(before, field) !== getArtifactFieldValue(after, field)
  })
  const operationDrift =
    operationKeysBefore.length === operationKeysAfter.length
    && operationKeysBefore.every((operationKey, index) => {
      return operationKey === operationKeysAfter[index]
    })
      ? []
      : ['operationMetrics.operationKey']

  return [...fieldDrift, ...operationDrift]
}

const getOperationMetricByKey = (
  artifact: ReviewServingSyntheticBenchmarkArtifact,
  operationKey: string,
) => {
  return artifact.operationMetrics.find((metrics) => {
    return metrics.operationKey === operationKey
  })
}

export const compareReviewServingSyntheticBenchmarkArtifacts = ({
  after,
  allowConfigDrift = false,
  before,
  nonTargetRegressionToleranceRatio = 0.1,
  targetOperation = after.targetOperation ?? before.targetOperation,
}: {
  after: ReviewServingSyntheticBenchmarkArtifact
  allowConfigDrift?: boolean
  before: ReviewServingSyntheticBenchmarkArtifact
  nonTargetRegressionToleranceRatio?: number
  targetOperation?: string | null
}): ReviewServingSyntheticBenchmarkCompareResult => {
  const configDrift = getConfigDrift(before, after)

  if (!allowConfigDrift && configDrift.length > 0) {
    throw new Error(`Review-serving benchmark config drift: ${configDrift.join(', ')}`)
  }

  const deltas = before.operationMetrics.flatMap((beforeMetrics) => {
    const afterMetrics = getOperationMetricByKey(after, beforeMetrics.operationKey)

    return afterMetrics
      ? [
          {
            after: afterMetrics,
            before: beforeMetrics,
            operationKey: beforeMetrics.operationKey,
            p95LatencyDeltaMs: Number((afterMetrics.p95LatencyMs - beforeMetrics.p95LatencyMs).toFixed(3)),
            p99LatencyDeltaMs: Number((afterMetrics.p99LatencyMs - beforeMetrics.p99LatencyMs).toFixed(3)),
            rowsReturnedDelta: afterMetrics.rowsReturned - beforeMetrics.rowsReturned,
            rowsScannedDelta: afterMetrics.rowsScanned - beforeMetrics.rowsScanned,
            tempSpillDeltaBytes: afterMetrics.tempSpillBytes - beforeMetrics.tempSpillBytes,
            writerBatchCountDelta: afterMetrics.writerBatchCount - beforeMetrics.writerBatchCount,
          },
        ]
      : []
  })
  const nonTargetRegressions = deltas.flatMap((delta) => {
    if (targetOperation && delta.operationKey === targetOperation) {
      return []
    }

    const maxAllowedP95 = delta.before.p95LatencyMs * (1 + nonTargetRegressionToleranceRatio)
    const maxAllowedRowsScanned = delta.before.rowsScanned * (1 + nonTargetRegressionToleranceRatio)
    const maxAllowedP95WithNoiseFloor = Math.max(maxAllowedP95, delta.before.p95LatencyMs + 100)

    return [
      {
        actual: delta.after.p95LatencyMs,
        budget: Number(maxAllowedP95WithNoiseFloor.toFixed(3)),
        metric: 'compare.latency.p95Ms',
        operationKey: delta.operationKey,
      },
      {
        actual: delta.after.rowsScanned,
        budget: Number(maxAllowedRowsScanned.toFixed(3)),
        metric: 'compare.rows.scanned',
        operationKey: delta.operationKey,
      },
    ].filter((violation) => {
      return violation.actual > violation.budget
    })
  })

  return {configDrift, deltas, nonTargetRegressions}
}
