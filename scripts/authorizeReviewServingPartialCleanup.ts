import type {
  ReviewServingChunkManifestRepositoryDatabase,
  ReviewServingChunkManifestRepositoryTransaction,
} from '../src/server/reviewServing/reviewServingChunkManifestRepository.ts'
import {
  authorizeReviewServingSummaryPartialCleanup,
  reviewServingSummaryPartialCleanupAuthorizationAck,
  type ReviewServingSummaryPartialCleanupAuthorizationTable,
} from '../src/server/reviewServing/reviewServingRebuildRequestRepository.ts'
import {getAppDatabaseService} from '../src/server/services/appDatabaseService.ts'
import {withDuckdbMaintenanceAccess} from '../src/server/utils/duckdbScriptAccess.ts'
import {getMaintenanceDuckdbWorkloadContext} from '../src/server/utils/duckdbService.ts'

type CliOptions = {
  acknowledgement: string | null
  apply: boolean
  chunkId: string | null
  expectedRowCount: number | null
  expiresAt: string | null
  minimumAgeMinutes: number
  partialTable: ReviewServingSummaryPartialCleanupAuthorizationTable | null
  projectId: string | null
  reason: string | null
  requestId: string | null
  reviewConfigHash: string | null
  snapshotId: string | null
}

const supportedPartialTables = new Set<ReviewServingSummaryPartialCleanupAuthorizationTable>([
  'mart.review_article_summary_rebuild_partial_v4',
])
const workloadContext = getMaintenanceDuckdbWorkloadContext('authorizeReviewServingPartialCleanup')

const getArgValue = (names: string[]) => {
  const matchedArgument = process.argv.slice(2).find((argument) => {
    return names.some((name) => {
      return argument.startsWith(`${name}=`)
    })
  })

  return matchedArgument?.slice(matchedArgument.indexOf('=') + 1).trim()
}

const hasFlag = (name: string) => {
  return process.argv.slice(2).includes(name)
}

const getNonNegativeIntegerOption = (value: string | undefined, fallback: number) => {
  const parsedValue = value === undefined ? Number.NaN : Number(value)

  return Number.isInteger(parsedValue) && parsedValue >= 0 ? parsedValue : fallback
}

const getRequiredNonNegativeIntegerOption = (value: string | undefined) => {
  const parsedValue = value === undefined ? Number.NaN : Number(value)

  return Number.isInteger(parsedValue) && parsedValue >= 0 ? parsedValue : null
}

const getPartialTableOption = (value: string | undefined) => {
  return value !== undefined
    && supportedPartialTables.has(value as ReviewServingSummaryPartialCleanupAuthorizationTable)
    ? (value as ReviewServingSummaryPartialCleanupAuthorizationTable)
    : null
}

const getMaintenanceDatabase = (): ReviewServingChunkManifestRepositoryDatabase => {
  const database = getAppDatabaseService()

  return {
    ...database,
    queryJson: <T>(statement: string) => {
      return database.queryJson<T>(statement, workloadContext)
    },
    run: (statement: string) => {
      return database.run(statement, workloadContext)
    },
    transaction: <T>(operation: (tx: ReviewServingChunkManifestRepositoryTransaction) => Promise<T>) => {
      return database.transaction(operation, workloadContext) as Promise<T>
    },
  }
}

const printResult = (result: unknown) => {
  console.log(
    JSON.stringify(
      {
        ...(typeof result === 'object' && result !== null ? result : {result}),
        acknowledgementRequiredForApply: reviewServingSummaryPartialCleanupAuthorizationAck,
        applyRequirement: 'dry-run preflight must report an empty refusalReasons array',
        mode: 'stale_orphan_summary_partial',
      },
      null,
      2,
    ),
  )
}

const getCliOptions = (): CliOptions => {
  return {
    acknowledgement: getArgValue(['--ack', '--acknowledgement']) ?? null,
    apply: hasFlag('--apply'),
    chunkId: getArgValue(['--chunk-id', '--chunkId']) ?? null,
    expectedRowCount: getRequiredNonNegativeIntegerOption(getArgValue(['--expected-row-count', '--expectedRowCount'])),
    expiresAt: getArgValue(['--expires-at', '--expiresAt']) ?? null,
    minimumAgeMinutes: getNonNegativeIntegerOption(getArgValue(['--minimum-age-minutes']), 60),
    partialTable: getPartialTableOption(getArgValue(['--partial-table', '--partialTable'])),
    projectId: getArgValue(['--project-id', '--projectId']) ?? null,
    reason: getArgValue(['--reason']) ?? null,
    requestId: getArgValue(['--request-id', '--requestId']) ?? null,
    reviewConfigHash: getArgValue(['--review-config-hash', '--reviewConfigHash']) ?? null,
    snapshotId: getArgValue(['--snapshot-id', '--snapshotId']) ?? null,
  }
}

const validateOptions = (options: CliOptions) => {
  const missing: string[] = []

  if (!options.projectId) {
    missing.push('--project-id=<project-id>')
  }
  if (!options.reviewConfigHash) {
    missing.push('--review-config-hash=<review-config-hash>')
  }
  if (!options.requestId) {
    missing.push('--request-id=<request-id>')
  }
  if (!options.chunkId) {
    missing.push('--chunk-id=<chunk-id>')
  }
  if (!options.snapshotId) {
    missing.push('--snapshot-id=<snapshot-id>')
  }
  if (!options.partialTable) {
    missing.push('--partial-table=<supported-partial-table>')
  }
  if (!options.reason) {
    missing.push('--reason=<operator-reason>')
  }
  if (options.expectedRowCount === null) {
    missing.push('--expected-row-count=<non-negative-integer>')
  }

  return missing
}

const authorizeReviewServingPartialCleanupCli = async () => {
  const options = getCliOptions()
  const missing = validateOptions(options)

  if (missing.length > 0) {
    console.error(`Missing required ${missing.join(', ')}`)
    process.exitCode = 1
    return
  }

  if (options.apply && options.acknowledgement !== reviewServingSummaryPartialCleanupAuthorizationAck) {
    console.error(`Refusing --apply without --ack=${reviewServingSummaryPartialCleanupAuthorizationAck}`)
    process.exitCode = 1
    return
  }

  await withDuckdbMaintenanceAccess('authorize review-serving partial cleanup', async () => {
    const database = getMaintenanceDatabase()
    const input = {
      chunkId: options.chunkId ?? '',
      expectedRowCount: options.expectedRowCount ?? 0,
      expiresAt: options.expiresAt ?? undefined,
      minimumAgeMinutes: options.minimumAgeMinutes,
      operatorAck: options.acknowledgement ?? '',
      partialTable: options.partialTable ?? 'mart.review_article_summary_rebuild_partial_v4',
      projectId: options.projectId ?? '',
      reason: options.reason ?? '',
      requestId: options.requestId ?? '',
      reviewConfigHash: options.reviewConfigHash ?? '',
      snapshotId: options.snapshotId ?? '',
    }

    if (!options.apply) {
      const result = await authorizeReviewServingSummaryPartialCleanup(input, database)

      printResult(result)
      return
    }

    const applyPreflight = await authorizeReviewServingSummaryPartialCleanup(input, database)

    if (applyPreflight.refusalReasons.length > 0 || applyPreflight.status !== 'dry_run') {
      process.exitCode = 1
      printResult({
        ...applyPreflight,
        applyPreflight,
        applySkippedReason: 'preflight_refusal_reasons_not_empty_or_not_dry_run',
        applied: false,
        status: 'refused',
      })
      return
    }

    const result = await authorizeReviewServingSummaryPartialCleanup({...input, apply: true}, database)

    if (!result.applied || result.refusalReasons.length > 0) {
      process.exitCode = 1
    }

    printResult({...result, applyPreflight})
  })
}

await authorizeReviewServingPartialCleanupCli()
