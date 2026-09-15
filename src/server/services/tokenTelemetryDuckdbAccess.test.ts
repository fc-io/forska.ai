import {readFileSync} from 'node:fs'

import {expect, test} from 'bun:test'

const readSource = (path: string) => {
  return readFileSync(path, 'utf8').replaceAll('\r\n', '\n')
}

const countMatches = (source: string, pattern: RegExp) => {
  return source.match(pattern)?.length ?? 0
}

const stripAllowedTelemetryUtilityShapes = (source: string) => {
  return source.replace(
    /\bROW_NUMBER\s*\(\)\s+OVER\s*\(\s*PARTITION BY job_id,\s*provider_key,\s*sampled_at\s*ORDER BY created_at ASC,\s*id ASC\s*\)\s+AS incoming_row_number/gi,
    '',
  )
}

const serviceSources = [
  'src/server/services/tokenUseQueryService.ts',
  'src/server/services/requestAttemptCloseoutService.ts',
  'src/server/services/judgmentProviderTelemetryHistoryService.ts',
].map(readSource)

test('token telemetry services do not contain project-review raw scan shapes', () => {
  const forbiddenReviewScanPatterns = [
    /selected_scoped_article_import/i,
    /\bROW_NUMBER\s*\(/i,
    /\bapp\.article\b/i,
    /\bapp\.judgment\b/i,
    /\bmart\.project_scope_article\b/i,
    /\bmart\.review_article_serving_v4\b/i,
  ]

  serviceSources.map((source) => {
    const scanSource = stripAllowedTelemetryUtilityShapes(source)

    forbiddenReviewScanPatterns.map((pattern) => {
      expect(scanSource).not.toMatch(pattern)
    })
  })
})

test('token use diagnostics carry workload contexts on direct app database calls', () => {
  const source = readSource('src/server/services/tokenUseQueryService.ts')

  expect(countMatches(source, /getAppDatabaseService\(\)\.transaction\(/g)).toBe(2)
  expect(countMatches(source, /}, tokenUseInsert(?:Once)?WorkloadContext\)/g)).toBe(2)
  expect(countMatches(source, /getAppDatabaseService\(\)\.queryJson</g)).toBe(10)
  expect(countMatches(source, /,\n {4}tokenUse[A-Za-z]+WorkloadContext,\n {2}\)/g)).toBe(10)
  expect(source).toContain('const failedRequestsMaxLimit = 100')
  expect(source).toContain('const failedRequestsMaxOffset = 10_000')
  expect(source).toContain('LIMIT ${pagination.limit}')
  expect(source).toContain('OFFSET ${pagination.offset}')
})

test('request attempt closeout scans are cursored or bounded and workload-contexted', () => {
  const source = readSource('src/server/services/requestAttemptCloseoutService.ts')

  expect(source).toContain('LIMIT ${batchSize}')
  expect(source).toContain('requestAttemptCloseoutStartupBackfillMaxBatches = 5')
  expect(source).toContain('requestAttemptCloseoutStartupBackfillMaxBatchSize = 1000')
  expect(source).toContain('requestAttemptCloseoutMaintenanceWorkloadContext')
  expect(source).toContain('requestAttemptCloseoutOnlineRebuildWorkloadContext')
  expect(source).toContain('requestAttemptCloseoutBackfillWorkloadContext')
  expect(source).not.toMatch(/OFFSET/i)
})

test('provider telemetry history queries are job-time scoped and workload-contexted', () => {
  const source = readSource('src/server/services/judgmentProviderTelemetryHistoryService.ts')

  expect(source).toContain('WHERE job_id = ${getSqlLiteral(params.jobId)}')
  expect(source).toContain('AND provider_key = ${getSqlLiteral(params.providerKey)}')
  expect(source).toContain('AND sampled_at >= ${getTimestampLiteral(range.rangeStart)}')
  expect(source).toContain('AND sampled_at < ${getTimestampLiteral(range.rangeEnd)}')
  expect(countMatches(source, /\.queryJson</g)).toBe(6)
  expect(
    countMatches(
      source,
      /,\n {4}judgmentProviderTelemetry(?:Insert|Prune|DeleteJob|BucketedHistory)WorkloadContext,\n {2}\)/g,
    ),
  ).toBe(6)
  expect(source).toContain('judgmentProviderTelemetryInsertWorkloadContext')
  expect(source).toContain('judgmentProviderTelemetryPruneWorkloadContext')
  expect(source).toContain('judgmentProviderTelemetryDeleteJobWorkloadContext')
  expect(source).toContain('judgmentProviderTelemetryBucketedHistoryWorkloadContext')
})
