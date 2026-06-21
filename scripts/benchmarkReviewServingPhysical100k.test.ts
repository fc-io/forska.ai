import {join, resolve} from 'node:path'

import {expect, test} from 'bun:test'

import {reviewServingBenchmarkPhase6PhysicalRehearsal100kFixture} from '../src/server/reviewServing/reviewServingBenchmark.ts'
import {
  getReviewServingPhase6PhysicalRehearsal100kWorkloadDefinition,
  getReviewServingPhysical100kBenchmarkInput,
  getReviewServingPhysical100kFixtureVerification,
  parseReviewServingPhysical100kBenchmarkArgs,
  reviewServingPhase6PhysicalRehearsal100kRunKind,
  type ReviewServingPhysical100kFixtureSamples,
  type ReviewServingPhysical100kSnapshotContext,
} from './benchmarkReviewServingPhysical100k.ts'

const projectRoot = process.cwd()

const context: ReviewServingPhysical100kSnapshotContext = {
  activeSnapshotIdentity: {
    countIdentity: 'summary-identity',
    manifestIdentity: 'project-scope-identity',
    projectId: 'project-1',
    reviewConfigHash: 'review-config-1',
    searchIdentity: 'search-identity',
    snapshotId: 'snapshot-1',
  },
  projectId: 'project-1',
  reviewConfigHash: 'review-config-1',
  snapshotId: 'snapshot-1',
}

const samples = {
  articleIds: ['article-1', 'article-2'],
  filterOptionIdentity: 'filter-option-identity',
  humanFacetSummaryIdentity: 'human-summary-identity',
  postingFilter: {filterKind: 'promptAnswer', filterValue: 'review:promptAnswer:prompt-1:yes', listMode: 'llm'},
  promptCounts: {
    'review.both.conflictByPrompt': {filterKey: 'prompt:prompt-1', value: 3},
    'review.human.reviewedByPrompt': {filterKey: 'prompt:prompt-1', value: 8},
    'review.llm.assessedByPrompt': {filterKey: 'prompt:prompt-1', value: 10},
    'review.llm.unassessedByPrompt': {filterKey: 'prompt:prompt-1', value: 2},
  },
  queueKind: 'unassessed',
  reviewFacetSummaryIdentity: 'review-summary-identity',
  searchTokenPrefix: 'hea',
} as ReviewServingPhysical100kFixtureSamples

test('review-serving physical 100k benchmark args require explicit fixture and output paths', () => {
  expect(() => {
    parseReviewServingPhysical100kBenchmarkArgs(['--fixture-path=/tmp/rehearsal.duckdb'])
  }).toThrow('Missing --output-dir')

  expect(
    parseReviewServingPhysical100kBenchmarkArgs([
      '--fixture-path=fixtures/review-serving-100k.duckdb',
      '--output-dir=.tmp/review-serving-evidence',
      '--duckdb-memory-limit=6400MiB',
      '--project-id=project-1',
      '--review-config-hash=null',
    ]),
  ).toEqual({
    duckdbMemoryLimit: '6400MiB',
    fixturePath: resolve('fixtures/review-serving-100k.duckdb'),
    outputDir: resolve('.tmp/review-serving-evidence'),
    projectId: 'project-1',
    reviewConfigHash: null,
  })
})

test('review-serving physical 100k fixture verification is exact and labeled as rehearsal', () => {
  expect(
    getReviewServingPhysical100kFixtureVerification(reviewServingBenchmarkPhase6PhysicalRehearsal100kFixture),
  ).toEqual({
    actual: {articleCount: 100_000, articlePromptOverlapRows: 700_000, promptCount: 7},
    expected: {articleCount: 100_000, articlePromptOverlapRows: 700_000, promptCount: 7},
    passed: true,
  })
  expect(
    getReviewServingPhysical100kFixtureVerification({
      articleCount: 10_000_000,
      articlePromptOverlapRows: 70_000_000,
      promptCount: 7,
    }).passed,
  ).toBe(false)
})

test('review-serving physical 100k workload scales Phase 6 operations without claiming the 10M gate', () => {
  const workload = getReviewServingPhase6PhysicalRehearsal100kWorkloadDefinition()

  expect(workload).toMatchObject({
    fixtureKind: 'phase6PhysicalRehearsal100k',
    key: 'reviewServing.phase6PhysicalRehearsal100k.v1',
    releaseGatePhase: 'Phase 6',
  })
  expect(workload.operations).toHaveLength(31)
  expect(
    workload.operations.every((operation) => {
      return operation.requestCount === 1 && operation.minimumDistinctRequestSlices === 1
    }),
  ).toBe(true)
  expect(
    workload.operations.every((operation) => {
      return operation.targetRowsReturnedPerRequest > 0
    }),
  ).toBe(true)
  expect(workload.operations.find((operation) => operation.key === 'filteredLlmRowsByArticleSet')).toMatchObject({
    targetRowsReturnedPerRequest: 2,
  })
  expect(workload.operations.find((operation) => operation.key === 'humanListJudgmentPayloadRows')).toMatchObject({
    targetRowsReturnedPerRequest: 14,
  })
})

test('review-serving physical 100k input emits non-release benchmark run kind and physical reader requests', () => {
  const input = getReviewServingPhysical100kBenchmarkInput(context, samples)

  expect(input.releaseContext?.benchmarkRunKind).toBe(reviewServingPhase6PhysicalRehearsal100kRunKind)
  expect(input.fixture.kind).toBe('phase6PhysicalRehearsal100k')
  expect(input.workItems).toHaveLength(31)
  expect(input.readerRequestsByWorkItemKey.get('physical-100k-filteredOverlapRows')).toMatchObject({
    filterKind: 'promptAnswer',
    filterValue: 'review:promptAnswer:prompt-1:yes',
    searchTokenPrefix: 'hea',
  })
  expect(input.readerRequestsByWorkItemKey.get('physical-100k-llmPromptOverlapCounts')).toMatchObject({
    countFilterKey: 'prompt:prompt-1',
    namedCountKey: 'review.llm.assessedByPrompt',
  })
})

test('package exposes the review-serving physical 100k benchmark command', async () => {
  const packageJson = (await globalThis.Bun.file(join(projectRoot, 'package.json')).json()) as {
    scripts: Record<string, string>
  }

  expect(packageJson.scripts['bench:review-serving-physical-100k']).toBe(
    'bun scripts/benchmarkReviewServingPhysical100k.ts',
  )
})
