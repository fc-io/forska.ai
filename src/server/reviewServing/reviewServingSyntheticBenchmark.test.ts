import {existsSync} from 'node:fs'

import {expect, test} from 'bun:test'

import {
  cleanupReviewServingSyntheticFixture,
  closeReviewServingSyntheticFixture,
  createReviewServingSyntheticFixture,
  getReviewServingSyntheticFixtureManifest,
  reviewServingSyntheticBenchmarkDefaultSeed,
  reviewServingSyntheticBenchmarkFixtureVersion,
} from './reviewServingSyntheticBenchmark.ts'

test('review-serving synthetic fixture manifest is deterministic by scale and seed', () => {
  expect(
    getReviewServingSyntheticFixtureManifest({duckdbMemoryLimit: '512MiB', scale: 'medium', seed: 123}),
  ).toEqual({
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

test('review-serving synthetic fixture seeds isolated DuckDB data and cleans up files', async () => {
  const fixture = await createReviewServingSyntheticFixture({duckdbMemoryLimit: '256MiB', scale: 'small'})

  try {
    const reader = await fixture.connection.runAndReadAll(`
      SELECT
        (SELECT COUNT(*) FROM article) AS articles,
        (SELECT COUNT(*) FROM prompt_overlap) AS overlapRows,
        (SELECT COUNT(*) FROM filter_option) AS filterOptions,
        (SELECT SUM(rows_written) FROM writer_diagnostic) AS writerRows
    `)

    expect(reader.getRowObjectsJson()).toEqual([
      {
        articles: '1000',
        filterOptions: '175',
        overlapRows: '7000',
        writerRows: '8175',
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
