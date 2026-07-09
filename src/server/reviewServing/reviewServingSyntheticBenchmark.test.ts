import {existsSync, readdirSync} from 'node:fs'

import {expect, test} from 'bun:test'

import {
  cleanupReviewServingSyntheticFixture,
  closeReviewServingSyntheticFixture,
  compareReviewServingSyntheticBenchmarkArtifacts,
  createReviewServingSyntheticFixture,
  getReviewServingSyntheticBenchmarkOperationSql,
  getReviewServingSyntheticFixtureManifest,
  reviewServingSyntheticBenchmarkDefaultSeed,
  reviewServingSyntheticBenchmarkFixtureVersion,
  runReviewServingSyntheticBenchmark,
} from './reviewServingSyntheticBenchmark.ts'

test('review-serving synthetic fixture manifest is deterministic by scale and seed', () => {
  expect(getReviewServingSyntheticFixtureManifest({duckdbMemoryLimit: '512MiB', scale: 'medium', seed: 123})).toEqual({
    articleCount: 10_000,
    articlePromptOverlapRows: 70_000,
    duckdbMemoryLimit: '512MiB',
    fixtureVersion: reviewServingSyntheticBenchmarkFixtureVersion,
    holdout: false,
    promptCount: 7,
    scale: 'medium',
    seed: 123,
  })
})

test('review-serving synthetic release scale uses the documented 10m fixture shape', () => {
  expect(
    getReviewServingSyntheticFixtureManifest({duckdbMemoryLimit: '20GiB', scale: 'release', seed: 123}),
  ).toMatchObject({articleCount: 10_000_000, articlePromptOverlapRows: 70_000_000})
})

test('review-serving synthetic holdout fixture uses a distinct default seed', async () => {
  const fixture = await createReviewServingSyntheticFixture({
    duckdbMemoryLimit: '256MiB',
    holdout: true,
    scale: 'small',
  })

  try {
    expect(fixture.manifest.holdout).toBe(true)
    expect(fixture.manifest.seed).toBe(reviewServingSyntheticBenchmarkDefaultSeed + 1)
  } finally {
    closeReviewServingSyntheticFixture(fixture)
    cleanupReviewServingSyntheticFixture(fixture)
  }
})

test('review-serving synthetic fixture cleanup removes partial setup failures', async () => {
  const benchmarkDirectory = '.tmp/benchmarks'
  const getFixtureDirectories = () => {
    if (!existsSync(benchmarkDirectory)) {
      return []
    }

    return readdirSync(benchmarkDirectory, {withFileTypes: true})
      .filter((entry) => {
        return entry.isDirectory() && entry.name.startsWith('review-serving-small-999-')
      })
      .map((entry) => {
        return entry.name
      })
  }
  const directoriesBefore = getFixtureDirectories()

  let failed = false

  try {
    await createReviewServingSyntheticFixture({duckdbMemoryLimit: 'not-a-memory-limit', scale: 'small', seed: 999})
  } catch {
    failed = true
  }

  expect(failed).toBe(true)
  expect(getFixtureDirectories()).toEqual(directoriesBefore)
})

test('review-serving synthetic fixture seeds isolated DuckDB data and cleans up files', async () => {
  const fixture = await createReviewServingSyntheticFixture({duckdbMemoryLimit: '256MiB', scale: 'small'})

  try {
    const reader = await fixture.connection.runAndReadAll(`
      SELECT
        (SELECT COUNT(*) FROM article) AS articles,
        (SELECT COUNT(*) FROM prompt_overlap) AS overlapRows,
        (SELECT COUNT(*) FROM filter_option) AS filterOptions,
        (SELECT SUM(rows_written) FROM writer_diagnostic) AS writerRows,
        (SELECT SUM(batch_count) FROM writer_diagnostic) AS writerBatches,
        (SELECT MAX(rows_per_batch) FROM writer_diagnostic) AS writerRowsPerBatch
    `)

    expect(reader.getRowObjectsJson()).toEqual([
      {
        articles: '1000',
        filterOptions: '175',
        overlapRows: '7000',
        writerBatches: '6',
        writerRows: '8273',
        writerRowsPerBatch: 7000,
      },
    ])
    expect(fixture.manifest.seed).toBe(reviewServingSyntheticBenchmarkDefaultSeed)
    expect(existsSync(fixture.duckdbPath)).toBe(true)
  } finally {
    closeReviewServingSyntheticFixture(fixture)
    cleanupReviewServingSyntheticFixture(fixture)
  }

  expect(existsSync(fixture.rootDirectory)).toBe(false)
})

test('review-serving synthetic benchmark writes a physical DuckDB artifact with operation metrics', async () => {
  const artifact = await runReviewServingSyntheticBenchmark({
    artifactDirectory: '.tmp/benchmarks/test-artifacts',
    command: 'bun test reviewServingSyntheticBenchmark.test.ts',
    duckdbMemoryLimit: '256MiB',
    mode: 'measure',
    scale: 'small',
    seed: 456,
  })

  try {
    expect(existsSync(artifact.artifactPath)).toBe(true)
    expect(artifact.budgetSettings.maxRowsScanned).toBe(250_000)
    expect(artifact.compareSettings.nonTargetRegressionToleranceRatio).toBe(0.1)
    expect(artifact.fixture).toMatchObject({articleCount: 1_000, promptCount: 7, scale: 'small', seed: 456})
    expect(artifact.operationMetrics).toHaveLength(31)
    expect(artifact.samples).toHaveLength(124)
    expect(
      artifact.samples.some((sample) => {
        return sample.warmup
      }),
    ).toBe(true)
    expect(artifact.totals.rowsScanned).toBeGreaterThan(0)
    expect(
      artifact.samples.every((sample) => {
        return Number.isFinite(sample.tempSpillBytes)
      }),
    ).toBe(true)
    expect(artifact.violations).toEqual([])
  } finally {
    cleanupReviewServingSyntheticFixture({
      duckdbPath: artifact.artifactPath,
      rootDirectory: '.tmp/benchmarks/test-artifacts',
    })
  }
})

test('review-serving synthetic benchmark compare blocks config drift and reports regressions', async () => {
  const before = await runReviewServingSyntheticBenchmark({
    artifactDirectory: '.tmp/benchmarks/test-compare-before',
    command: 'before',
    duckdbMemoryLimit: '256MiB',
    mode: 'measure',
    scale: 'small',
    seed: 789,
  })
  const matchingAfter = {...before, artifactPath: 'after.json', command: 'after'}
  const driftedAfter = {...matchingAfter, fixture: {...matchingAfter.fixture, seed: 790}}
  const driftedBudgetAfter = {
    ...matchingAfter,
    budgetSettings: {...matchingAfter.budgetSettings, maxRowsScanned: matchingAfter.budgetSettings.maxRowsScanned + 1},
  }
  const driftedCompareAfter = {
    ...matchingAfter,
    compareSettings: {
      ...matchingAfter.compareSettings,
      nonTargetRegressionToleranceRatio: matchingAfter.compareSettings.nonTargetRegressionToleranceRatio + 0.01,
    },
  }
  const driftedModeAfter = {...matchingAfter, mode: 'check' as const}
  const driftedDuckdbVersionAfter = {...matchingAfter, duckdbVersion: `${matchingAfter.duckdbVersion}-drift`}
  const driftedPlatformAfter = {...matchingAfter, platform: {...matchingAfter.platform, bunVersion: '0.0.0-drift'}}
  const driftedSampleCountAfter = {
    ...matchingAfter,
    operationMetrics: matchingAfter.operationMetrics.map((metrics, index) => {
      return index === 0 ? {...metrics, sampleCount: metrics.sampleCount - 1} : metrics
    }),
  }
  const driftedSamplePlanAfter = {...matchingAfter, samples: matchingAfter.samples.slice(1)}
  const driftedTargetMetricAfter = {...matchingAfter, targetMetric: 'compare.rows.scanned'}
  const driftedTargetAfter = {...matchingAfter, targetOperation: 'llmPromptOverlapRows'}
  const regressedAfter = {
    ...matchingAfter,
    operationMetrics: matchingAfter.operationMetrics.map((metrics, index) => {
      return index === 0
        ? {
            ...metrics,
            p95LatencyMs: metrics.p95LatencyMs * 2 + 1,
            rowsScanned: metrics.rowsScanned * 2 + 1,
            tempSpillBytes: metrics.tempSpillBytes + 1,
            writerBatchCount: metrics.writerBatchCount * 2 + 1,
          }
        : metrics
    }),
  }
  const rssRegressedAfter = {
    ...matchingAfter,
    totals: {
      ...matchingAfter.totals,
      peakRssBytes: matchingAfter.totals.peakRssBytes * 2 + 1,
      rssGrowthBytes: matchingAfter.totals.rssGrowthBytes * 2 + 1,
    },
  }
  const firstBeforeMetrics = before.operationMetrics[0]
  const firstAfterMetrics = regressedAfter.operationMetrics[0]

  if (!firstBeforeMetrics || !firstAfterMetrics) {
    throw new Error('Missing compare metrics')
  }

  try {
    expect(() => {
      compareReviewServingSyntheticBenchmarkArtifacts({after: driftedAfter, before})
    }).toThrow('config drift')
    expect(() => {
      compareReviewServingSyntheticBenchmarkArtifacts({after: driftedBudgetAfter, before})
    }).toThrow('budgetSettings.maxRowsScanned')
    expect(() => {
      compareReviewServingSyntheticBenchmarkArtifacts({after: driftedCompareAfter, before})
    }).toThrow('compareSettings.nonTargetRegressionToleranceRatio')
    expect(() => {
      compareReviewServingSyntheticBenchmarkArtifacts({after: driftedModeAfter, before})
    }).toThrow('mode')
    expect(() => {
      compareReviewServingSyntheticBenchmarkArtifacts({after: driftedDuckdbVersionAfter, before})
    }).toThrow('duckdbVersion')
    expect(() => {
      compareReviewServingSyntheticBenchmarkArtifacts({after: driftedPlatformAfter, before})
    }).toThrow('platform.bunVersion')
    expect(() => {
      compareReviewServingSyntheticBenchmarkArtifacts({after: driftedSampleCountAfter, before})
    }).toThrow('operationMetrics.sampleCount')
    expect(() => {
      compareReviewServingSyntheticBenchmarkArtifacts({after: driftedSamplePlanAfter, before})
    }).toThrow('samples.samplePlan')
    expect(() => {
      compareReviewServingSyntheticBenchmarkArtifacts({after: driftedTargetMetricAfter, before})
    }).toThrow('targetMetric')
    expect(() => {
      compareReviewServingSyntheticBenchmarkArtifacts({after: driftedTargetAfter, before})
    }).toThrow('targetOperation')
    const result = compareReviewServingSyntheticBenchmarkArtifacts({after: regressedAfter, before})

    expect(result.deltas).toHaveLength(31)
    expect(result.nonTargetRegressions).toContainEqual({
      actual: firstAfterMetrics.rowsScanned,
      budget: Number((firstBeforeMetrics.rowsScanned * 1.1).toFixed(3)),
      metric: 'compare.rows.scanned',
      operationKey: firstBeforeMetrics.operationKey,
    })
    expect(result.nonTargetRegressions).toContainEqual({
      actual: firstAfterMetrics.tempSpillBytes,
      budget: firstBeforeMetrics.tempSpillBytes * 1.1,
      metric: 'compare.temp.spillBytes',
      operationKey: firstBeforeMetrics.operationKey,
    })
    expect(result.nonTargetRegressions).toContainEqual({
      actual: firstAfterMetrics.writerBatchCount,
      budget: Number((firstBeforeMetrics.writerBatchCount * 1.1).toFixed(3)),
      metric: 'compare.writer.batchCount',
      operationKey: firstBeforeMetrics.operationKey,
    })
    const targetResult = compareReviewServingSyntheticBenchmarkArtifacts({
      after: {
        ...regressedAfter,
        targetMetric: 'compare.rows.scanned',
        targetOperation: firstBeforeMetrics.operationKey,
      },
      allowConfigDrift: true,
      before,
    })
    expect(targetResult.nonTargetRegressions).not.toContainEqual({
      actual: firstAfterMetrics.rowsScanned,
      budget: Number((firstBeforeMetrics.rowsScanned * 1.1).toFixed(3)),
      metric: 'compare.rows.scanned',
      operationKey: firstBeforeMetrics.operationKey,
    })
    expect(targetResult.nonTargetRegressions).toContainEqual({
      actual: firstAfterMetrics.tempSpillBytes,
      budget: firstBeforeMetrics.tempSpillBytes * 1.1,
      metric: 'compare.temp.spillBytes',
      operationKey: firstBeforeMetrics.operationKey,
    })
    const rssResult = compareReviewServingSyntheticBenchmarkArtifacts({after: rssRegressedAfter, before})
    expect(rssResult.nonTargetRegressions).toContainEqual({
      actual: rssRegressedAfter.totals.peakRssBytes,
      budget: Number((before.totals.peakRssBytes * 1.1).toFixed(3)),
      metric: 'compare.rss.peakBytes',
    })
    expect(rssResult.nonTargetRegressions).toContainEqual({
      actual: rssRegressedAfter.totals.rssGrowthBytes,
      budget: Number((before.totals.rssGrowthBytes * 1.1).toFixed(3)),
      metric: 'compare.rss.growthBytes',
    })
  } finally {
    cleanupReviewServingSyntheticFixture({
      duckdbPath: before.artifactPath,
      rootDirectory: '.tmp/benchmarks/test-compare-before',
    })
  }
})

test('review-serving synthetic operation SQL exercises operation-specific predicates', () => {
  expect(getReviewServingSyntheticBenchmarkOperationSql('llmPromptOverlapCounts', 1)).toContain(
    "llm_status = 'assessed'",
  )
  expect(getReviewServingSyntheticBenchmarkOperationSql('humanPromptOverlapCounts', 1)).toContain(
    "human_status = 'reviewed'",
  )
  expect(getReviewServingSyntheticBenchmarkOperationSql('unassessedPromptOverlapCounts', 1)).toContain(
    "llm_status = 'unassessed'",
  )
  expect(getReviewServingSyntheticBenchmarkOperationSql('detailJudgmentPayloadRows', 1)).toContain('llm_payload')
  expect(getReviewServingSyntheticBenchmarkOperationSql('substringOverlapSearchJob', 1)).toContain(
    'async_substring_state',
  )
  expect(getReviewServingSyntheticBenchmarkOperationSql('llmPromptOverlapRows', 1)).toContain('candidate_rows')
})

test('review-serving synthetic micro-perf keeps high-risk operation shapes bounded', async () => {
  const artifact = await runReviewServingSyntheticBenchmark({
    artifactDirectory: '.tmp/benchmarks/test-micro-perf',
    command: 'micro-perf',
    duckdbMemoryLimit: '256MiB',
    mode: 'measure',
    scale: 'small',
    seed: 321,
  })
  const getOperation = (operationKey: string) => {
    const operation = artifact.operationMetrics.find((candidate) => {
      return candidate.operationKey === operationKey
    })

    if (!operation) {
      throw new Error(`Missing operation ${operationKey}`)
    }

    return operation
  }

  try {
    expect(getOperation('overlapFilterOptions').rowsScanned).toBeLessThanOrEqual(3_000)
    expect(getOperation('llmPromptOverlapCounts').rowsReturned).toBe(3)
    expect(getOperation('titlePrefixOverlapSearch').rowsReturned).toBeLessThanOrEqual(150)
    expect(getOperation('llmPromptOverlapRows').rowsReturned).toBeLessThanOrEqual(300)
    expect(artifact.totals.writerBatchCount).toBeLessThanOrEqual(12)
    expect(artifact.totals.tempSpillBytes).toBe(0)
  } finally {
    cleanupReviewServingSyntheticFixture({
      duckdbPath: artifact.artifactPath,
      rootDirectory: '.tmp/benchmarks/test-micro-perf',
    })
  }
})
