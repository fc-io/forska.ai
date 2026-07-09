import {mkdtempSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

import {expect, test} from 'bun:test'

import {runReviewServingSyntheticBenchmark} from '../src/server/reviewServing/reviewServingSyntheticBenchmark.ts'

test('review-serving compare CLI preserves artifact target labels when flag is absent', async () => {
  const artifactDirectory = mkdtempSync(join(tmpdir(), 'review-serving-compare-cli-'))
  const before = await runReviewServingSyntheticBenchmark({
    artifactDirectory,
    command: 'before',
    duckdbMemoryLimit: '256MiB',
    mode: 'measure',
    scale: 'small',
    seed: 654,
    targetMetric: 'compare.rows.scanned',
    targetOperation: 'llmPromptOverlapRows',
  })
  const afterPath = join(artifactDirectory, 'after.json')
  const after = {
    ...before,
    artifactPath: afterPath,
    command: 'after',
    operationMetrics: before.operationMetrics.map((metrics) => {
      return metrics.operationKey === before.targetOperation
        ? {...metrics, rowsScanned: metrics.rowsScanned * 2 + 1}
        : metrics
    }),
  }

  try {
    writeFileSync(afterPath, JSON.stringify(after, null, 2))
    const result = Bun.spawnSync({
      cmd: ['bun', 'scripts/benchmarkReviewServingCompare.ts', `--before=${before.artifactPath}`, `--after=${afterPath}`],
      stderr: 'pipe',
      stdout: 'pipe',
    })

    expect(result.exitCode).toBe(0)
    expect(JSON.parse(result.stdout.toString()).nonTargetRegressions).toEqual([])
  } finally {
    rmSync(artifactDirectory, {force: true, recursive: true})
  }
})

test('review-serving synthetic CLI rejects unconfirmed release scale', () => {
  const result = Bun.spawnSync({
    cmd: ['bun', 'scripts/benchmarkReviewServingSynthetic.ts', '--scale=release', '--mode=measure'],
    stderr: 'pipe',
    stdout: 'pipe',
  })

  expect(result.exitCode).not.toBe(0)
  expect(result.stderr.toString()).toContain('Release-scale review-serving benchmark is manual/long-running')
})
