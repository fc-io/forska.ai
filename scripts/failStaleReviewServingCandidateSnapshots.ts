import {
  failStaleCandidateReviewServingSnapshotManifests,
  type FailStaleCandidateReviewServingSnapshotManifestsResult,
  type ReviewServingManifestRepositoryDatabase,
  type ReviewServingManifestRepositoryTransaction,
} from '../src/server/reviewServing/reviewServingManifestRepository.ts'
import {getAppDatabaseService} from '../src/server/services/appDatabaseService.ts'
import {withDuckdbMaintenanceAccess} from '../src/server/utils/duckdbScriptAccess.ts'
import {getMaintenanceDuckdbWorkloadContext} from '../src/server/utils/duckdbService.ts'

/**
 * One-shot operator recovery for review-serving candidate snapshots that were left behind as
 * `candidate` (for example after a rebuild request failed validation before candidates were marked
 * failed on rejection). A candidate is stale when it is older than the active snapshot with the same
 * review config hash and is not referenced by any pending/running rebuild chunk or non-terminal
 * rebuild request. Stale candidates are marked `failed` with a "superseded by snapshot" last_error;
 * retention then cleans them up like any other failed snapshot. No rows are deleted.
 *
 * Usage (dry-run is the default):
 *   bun scripts/failStaleReviewServingCandidateSnapshots.ts --project-id=<project-id> [--snapshot-id=<snapshot-id>]
 *   bun scripts/failStaleReviewServingCandidateSnapshots.ts --project-id=<project-id> --apply --ack=<acknowledgement>
 */

export type FailStaleReviewServingCandidateSnapshotsCliOptions = {
  acknowledgement: string | null
  apply: boolean
  projectId: string | null
  snapshotId: string | null
}

export type FailStaleReviewServingCandidateSnapshotsCliResult = {
  acknowledgementRequiredForApply: string
  applied: boolean
  applyPreflight?: FailStaleCandidateReviewServingSnapshotManifestsResult
  applySkippedReason?: string
  mode: 'fail_stale_candidate_snapshots'
  refusalReasons: string[]
  result: FailStaleCandidateReviewServingSnapshotManifestsResult | null
  status: 'applied' | 'dry_run' | 'refused'
}

export const requiredApplyAcknowledgement = 'fail-stale-review-serving-candidate-snapshots-no-cleanup-authorized'
const mode = 'fail_stale_candidate_snapshots' as const
const workloadContext = getMaintenanceDuckdbWorkloadContext('failStaleReviewServingCandidateSnapshots')

const getArgValue = (argv: readonly string[], names: string[]) => {
  const matchedArgument = argv.find((argument) => {
    return names.some((name) => {
      return argument.startsWith(`${name}=`)
    })
  })

  return matchedArgument?.slice(matchedArgument.indexOf('=') + 1).trim()
}

const hasFlag = (argv: readonly string[], name: string) => {
  return argv.includes(name)
}

const getOptionalId = (value: string | undefined) => {
  return value === undefined || value === '' ? null : value
}

export const getFailStaleReviewServingCandidateSnapshotsCliOptions = (
  argv: readonly string[] = process.argv.slice(2),
): FailStaleReviewServingCandidateSnapshotsCliOptions => {
  return {
    acknowledgement: getOptionalId(getArgValue(argv, ['--ack', '--acknowledgement'])),
    apply: hasFlag(argv, '--apply') && !hasFlag(argv, '--dry-run'),
    projectId: getOptionalId(getArgValue(argv, ['--project-id', '--projectId'])),
    snapshotId: getOptionalId(getArgValue(argv, ['--snapshot-id', '--snapshotId'])),
  }
}

export const getFailStaleReviewServingCandidateSnapshotsRefusalReasons = (
  options: FailStaleReviewServingCandidateSnapshotsCliOptions,
) => {
  return [
    ...(options.projectId === null ? ['missing_project_id'] : []),
    ...(options.apply && options.acknowledgement !== requiredApplyAcknowledgement
      ? ['missing_apply_acknowledgement']
      : []),
  ]
}

const getMaintenanceDatabase = (): ReviewServingManifestRepositoryDatabase => {
  const database = getAppDatabaseService()

  return {
    queryJson: <T>(statement: string) => {
      return database.queryJson<T>(statement, workloadContext)
    },
    run: (statement: string) => {
      return database.run(statement, workloadContext)
    },
    transaction: <T>(operation: (tx: ReviewServingManifestRepositoryTransaction) => Promise<T>) => {
      return database.transaction(operation, workloadContext)
    },
  }
}

export const runFailStaleReviewServingCandidateSnapshots = async (
  options: FailStaleReviewServingCandidateSnapshotsCliOptions,
  database: ReviewServingManifestRepositoryDatabase,
): Promise<FailStaleReviewServingCandidateSnapshotsCliResult> => {
  const refusalReasons = getFailStaleReviewServingCandidateSnapshotsRefusalReasons(options)
  const projectId = options.projectId ?? ''

  if (refusalReasons.length > 0) {
    return {
      acknowledgementRequiredForApply: requiredApplyAcknowledgement,
      applied: false,
      mode,
      refusalReasons,
      result: null,
      status: 'refused',
    }
  }

  const dryRun = await failStaleCandidateReviewServingSnapshotManifests(
    {apply: false, projectId, snapshotId: options.snapshotId},
    database,
  )

  if (!options.apply) {
    return {
      acknowledgementRequiredForApply: requiredApplyAcknowledgement,
      applied: false,
      mode,
      refusalReasons: [],
      result: dryRun,
      status: 'dry_run',
    }
  }

  if (dryRun.staleCandidates.length === 0) {
    return {
      acknowledgementRequiredForApply: requiredApplyAcknowledgement,
      applied: false,
      applyPreflight: dryRun,
      applySkippedReason: 'no_stale_candidate_snapshots',
      mode,
      refusalReasons: [],
      result: dryRun,
      status: 'dry_run',
    }
  }

  const applied = await database.transaction((tx) => {
    return failStaleCandidateReviewServingSnapshotManifests(
      {apply: true, projectId, snapshotId: options.snapshotId},
      tx,
    )
  })

  return {
    acknowledgementRequiredForApply: requiredApplyAcknowledgement,
    applied: applied.failedSnapshotIds.length > 0,
    applyPreflight: dryRun,
    mode,
    refusalReasons: [],
    result: applied,
    status: 'applied',
  }
}

const failStaleReviewServingCandidateSnapshotsCli = async () => {
  const options = getFailStaleReviewServingCandidateSnapshotsCliOptions()
  const refusalReasons = getFailStaleReviewServingCandidateSnapshotsRefusalReasons(options)

  if (refusalReasons.includes('missing_project_id')) {
    console.error('Missing required --project-id=<project-id>')
    process.exitCode = 1
    return
  }

  if (refusalReasons.includes('missing_apply_acknowledgement')) {
    console.error(`Refusing --apply without --ack=${requiredApplyAcknowledgement}`)
    process.exitCode = 1
    return
  }

  await withDuckdbMaintenanceAccess('fail stale review-serving candidate snapshots', async () => {
    const result = await runFailStaleReviewServingCandidateSnapshots(options, getMaintenanceDatabase())

    if (result.status === 'refused' || (options.apply && !result.applied)) {
      process.exitCode = 1
    }

    console.log(JSON.stringify(result, null, 2))
  })
}

if (import.meta.main) {
  await failStaleReviewServingCandidateSnapshotsCli()
}
