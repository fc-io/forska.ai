import {expect, test} from 'bun:test'

import {
  getProjectTransferCommitExecutionMode,
  getProjectTransferExportExecutionMode,
  getProjectTransferImportAnalyzeExecutionMode,
  projectTransferCancellationRules,
  projectTransferConflictCountKeys,
  type ProjectTransferDependencyStatus,
  projectTransferDependencyStatuses,
  projectTransferExecutionThresholds,
  projectTransferOverlapSummaryKeys,
  type ProjectTransferPlanSummary,
  type ProjectTransferResourceGateInput,
  projectTransferResourceGateLimits,
  validateProjectTransferDependencyStatuses,
  validateProjectTransferPlanReadyToCommit,
  validateProjectTransferProgressUpdate,
  validateProjectTransferReadyDependencyStatuses,
  validateProjectTransferResourceGates,
} from './projectTransferContracts.ts'

const projectTransferMiB = 1024 * 1024
const projectTransferGiB = 1024 * projectTransferMiB

const getReadyPlanSummary = (): ProjectTransferPlanSummary => {
  return {
    blockerCount: 0,
    conflictCounts: {
      articleIdentifier: 0,
      dependency: 0,
      humanReview: 0,
      judgment: 0,
      packageContract: 0,
      projectPrompt: 0,
    },
    dependencyStatuses: {model: 'resolved', providerConnection: 'not_required'},
    overlapCounts: {exactDuplicateImports: 0, reusedArticles: 0},
    warningCount: 0,
  }
}

const getValidResourceGateInput = (
  overrides: Partial<ProjectTransferResourceGateInput> = {},
): ProjectTransferResourceGateInput => {
  return {
    archiveInodeCount: projectTransferResourceGateLimits.maxArchiveInodeCount,
    archiveMemberCount: projectTransferResourceGateLimits.maxArchiveMemberCount,
    availableDiskBytes: 1_100,
    expandedBytes: 50 * projectTransferMiB,
    fileBytes: projectTransferResourceGateLimits.maxSingleFileBytes,
    jsonDepth: projectTransferResourceGateLimits.maxJsonDepth,
    jsonMemberCount: projectTransferResourceGateLimits.maxJsonMemberCount,
    ndjsonLineBytes: projectTransferResourceGateLimits.maxNdjsonLineBytes,
    resourcePaths: [
      {kind: 'archive_member', pathValue: 'project.json'},
      {kind: 'runtime_asset', pathValue: 'assets/project-transfer/session-1/article.pdf'},
    ],
    targetWriteBytes: 1_000,
    tempRootPath: 'tmp/project-transfer/import/session-1',
    usesStreamingParser: true,
    zipBytes: 1 * projectTransferMiB,
    ...overrides,
  }
}

const getResourceGateError = (overrides: Partial<ProjectTransferResourceGateInput>) => {
  const result = validateProjectTransferResourceGates(getValidResourceGateInput(overrides))

  return result.ok ? null : result.error
}

test('locks project-transfer execution thresholds at inclusive and background boundaries', () => {
  expect(projectTransferExecutionThresholds.exportInlinePackageBytes).toBe(128 * projectTransferMiB)
  expect(projectTransferExecutionThresholds.exportInlineAssetBytes).toBe(64 * projectTransferMiB)
  expect(projectTransferExecutionThresholds.importAnalyzeInlineZipBytes).toBe(128 * projectTransferMiB)
  expect(projectTransferExecutionThresholds.importAnalyzeInlineExpandedBytes).toBe(512 * projectTransferMiB)
  expect(projectTransferExecutionThresholds.commitBackgroundArticleCount).toBe(25_000)
  expect(projectTransferExecutionThresholds.commitBackgroundJudgmentCount).toBe(250_000)
  expect(projectTransferExecutionThresholds.commitBackgroundExtractedAssetBytes).toBe(2 * projectTransferGiB)

  expect(
    getProjectTransferExportExecutionMode({
      assetBytes: projectTransferExecutionThresholds.exportInlineAssetBytes,
      packageBytes: projectTransferExecutionThresholds.exportInlinePackageBytes,
    }),
  ).toBe('inline')
  expect(
    getProjectTransferExportExecutionMode({
      assetBytes: projectTransferExecutionThresholds.exportInlineAssetBytes + 1,
      packageBytes: projectTransferExecutionThresholds.exportInlinePackageBytes,
    }),
  ).toBe('background')
  expect(
    getProjectTransferImportAnalyzeExecutionMode({
      expandedBytes: projectTransferExecutionThresholds.importAnalyzeInlineExpandedBytes,
      zipBytes: projectTransferExecutionThresholds.importAnalyzeInlineZipBytes,
    }),
  ).toBe('inline')
  expect(
    getProjectTransferImportAnalyzeExecutionMode({
      expandedBytes: projectTransferExecutionThresholds.importAnalyzeInlineExpandedBytes + 1,
      zipBytes: projectTransferExecutionThresholds.importAnalyzeInlineZipBytes,
    }),
  ).toBe('background')
  expect(
    getProjectTransferCommitExecutionMode({
      articleCount: projectTransferExecutionThresholds.commitBackgroundArticleCount - 1,
      extractedAssetBytes: projectTransferExecutionThresholds.commitBackgroundExtractedAssetBytes - 1,
      judgmentCount: projectTransferExecutionThresholds.commitBackgroundJudgmentCount - 1,
    }),
  ).toBe('inline')
  expect(
    getProjectTransferCommitExecutionMode({
      articleCount: projectTransferExecutionThresholds.commitBackgroundArticleCount,
      extractedAssetBytes: 0,
      judgmentCount: 0,
    }),
  ).toBe('background')
})

test('locks project-transfer resource gates for temp roots, disk headroom, budgets, and parser safety', () => {
  expect(projectTransferResourceGateLimits.writableTempRoot).toBe('tmp/project-transfer')
  expect(projectTransferResourceGateLimits.minimumDiskHeadroomRatio).toBe(0.1)
  expect(projectTransferResourceGateLimits.maxPathLength).toBe(2048)
  expect(projectTransferResourceGateLimits.maxPathSegmentLength).toBe(255)
  expect(projectTransferResourceGateLimits.maxDecompressionRatio).toBe(100)

  expect(validateProjectTransferResourceGates(getValidResourceGateInput())).toEqual({ok: true})
  expect(getResourceGateError({tempRootPath: 'assets/project-transfer/session-1'})).toContain('temp root')
  expect(getResourceGateError({tempRootPath: 'tmp/project-transfer/../outside'})).toContain('traversal')
  expect(getResourceGateError({availableDiskBytes: 1_099})).toContain('disk headroom')
  expect(
    getResourceGateError({archiveMemberCount: projectTransferResourceGateLimits.maxArchiveMemberCount + 1}),
  ).toContain('archive member budget')
  expect(
    getResourceGateError({archiveInodeCount: projectTransferResourceGateLimits.maxArchiveInodeCount + 1}),
  ).toContain('archive inode budget')
  expect(getResourceGateError({fileBytes: projectTransferResourceGateLimits.maxSingleFileBytes + 1})).toContain(
    'file-size limit',
  )
  expect(getResourceGateError({ndjsonLineBytes: projectTransferResourceGateLimits.maxNdjsonLineBytes + 1})).toContain(
    'NDJSON line-size',
  )
  expect(getResourceGateError({jsonDepth: projectTransferResourceGateLimits.maxJsonDepth + 1})).toContain('JSON depth')
  expect(getResourceGateError({jsonMemberCount: projectTransferResourceGateLimits.maxJsonMemberCount + 1})).toContain(
    'JSON member-count',
  )
  expect(getResourceGateError({usesStreamingParser: false})).toContain('streaming parsers')
  expect(getResourceGateError({expandedBytes: 101 * projectTransferMiB, zipBytes: 1 * projectTransferMiB})).toContain(
    'decompression ratio',
  )
  expect(getResourceGateError({resourcePaths: [{kind: 'archive_member', pathValue: '../project.json'}]})).toContain(
    'traversal',
  )
})

test('validates dependency statuses and ready dependency statuses separately', () => {
  expect(projectTransferDependencyStatuses).toEqual(['ambiguous', 'blocked', 'missing', 'not_required', 'resolved'])
  expect(validateProjectTransferDependencyStatuses({model: 'resolved', providerConnection: 'not_required'})).toEqual({
    ok: true,
  })
  expect(validateProjectTransferDependencyStatuses({model: 'unknown' as ProjectTransferDependencyStatus})).toEqual({
    error: 'Project transfer dependency model has unknown status unknown',
    ok: false,
  })
  expect(validateProjectTransferReadyDependencyStatuses({model: 'ambiguous'})).toEqual({
    error: 'Project transfer dependency model is not ready to commit',
    ok: false,
  })
})

test('requires concrete overlap and conflict counts before ready_to_commit', () => {
  const readyPlan = getReadyPlanSummary()
  const {judgment: _judgment, ...conflictCountsWithoutJudgment} = readyPlan.conflictCounts

  expect(projectTransferOverlapSummaryKeys).toEqual(['exactDuplicateImports', 'reusedArticles'])
  expect(projectTransferConflictCountKeys).toEqual([
    'articleIdentifier',
    'dependency',
    'humanReview',
    'judgment',
    'packageContract',
    'projectPrompt',
  ])
  expect(validateProjectTransferPlanReadyToCommit(readyPlan)).toEqual({ok: true})
  expect(
    validateProjectTransferPlanReadyToCommit({
      ...readyPlan,
      conflictCounts: conflictCountsWithoutJudgment as ProjectTransferPlanSummary['conflictCounts'],
    }),
  ).toEqual({error: 'Project transfer missing required conflict count judgment', ok: false})
  expect(
    validateProjectTransferPlanReadyToCommit({
      ...readyPlan,
      conflictCounts: {...readyPlan.conflictCounts, judgment: -1},
    }),
  ).toEqual({error: 'Project transfer conflict count judgment must be a non-negative integer', ok: false})
})

test('keeps progress monotonic and cancellation cleanup writer-only', () => {
  expect(
    validateProjectTransferProgressUpdate({
      next: {completedBytes: 3, phase: 'upload', status: 'running', totalBytes: 9},
      previous: {completedBytes: 2, phase: 'upload', status: 'running', totalBytes: 10},
    }),
  ).toEqual({error: 'Project transfer progress field totalBytes must be monotonic', ok: false})
  expect(projectTransferCancellationRules.cancelled).toEqual({
    cleanupTempArtifacts: true,
    requiresWriterOwnerToken: true,
    state: 'cancelled',
  })
  expect(projectTransferCancellationRules.expired).toEqual({
    cleanupTempArtifacts: true,
    requiresWriterOwnerToken: true,
    state: 'expired',
  })
})
