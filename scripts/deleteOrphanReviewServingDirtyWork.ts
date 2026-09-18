import type {
  ReviewServingDirtyWorkDatabase,
  ReviewServingDirtyWorkTransaction,
} from '../src/server/reviewServing/reviewServingDirtyWorkService.ts'
import {getAppDatabaseService} from '../src/server/services/appDatabaseService.ts'
import {getSqlLiteral} from '../src/server/services/appQueryHelpers.ts'
import {withDuckdbMaintenanceAccess} from '../src/server/utils/duckdbScriptAccess.ts'
import {getMaintenanceDuckdbWorkloadContext} from '../src/server/utils/duckdbService.ts'

/**
 * One-shot operator cleanup for orphan review-serving dirty work: `pending` rows whose
 * `projection_component` is NULL and that were created before a given instant (typically the
 * activation time of the project's active full-coverage snapshot). Such rows predate the snapshot,
 * can never drain usefully, and draining them after a lane repair would trigger full component
 * rebuilds. The script deletes the rows together with their `review_serving_dirty_work_claim_state`
 * and `review_serving_dirty_work_id_lookup` companions in one transaction. Acknowledgement and
 * watermark tables are never touched.
 *
 * Usage (dry-run is the default and only counts):
 *   bun scripts/deleteOrphanReviewServingDirtyWork.ts --project-id=<project-id> --created-before=<ISO timestamp> [--limit=<n>]
 *   bun scripts/deleteOrphanReviewServingDirtyWork.ts --project-id=<project-id> --created-before=<ISO timestamp> [--limit=<n>] --apply --ack=<acknowledgement>
 */

export type DeleteOrphanReviewServingDirtyWorkCliOptions = {
  acknowledgement: string | null
  apply: boolean
  createdBefore: string | null
  limit: number | null
  projectId: string | null
}

export type DeleteOrphanReviewServingDirtyWorkCounts = {
  claimStateRows: number
  dirtyWorkRows: number
  idLookupRows: number
}

export type DeleteOrphanReviewServingDirtyWorkCliResult = {
  acknowledgementRequiredForApply: string
  applied: boolean
  applyPreflight?: DeleteOrphanReviewServingDirtyWorkCounts
  applySkippedReason?: string
  createdBefore: string | null
  limit: number | null
  mode: 'delete_orphan_dirty_work'
  projectId: string | null
  refusalReasons: string[]
  result: DeleteOrphanReviewServingDirtyWorkCounts | null
  status: 'applied' | 'dry_run' | 'refused'
}

export const requiredApplyAcknowledgement = 'delete-orphan-review-serving-dirty-work-permanently-no-rebuild-authorized'
export const orphanDirtyWorkTempTable = 'orphan_review_serving_dirty_work_doomed'
const mode = 'delete_orphan_dirty_work' as const
const workloadContext = getMaintenanceDuckdbWorkloadContext('deleteOrphanReviewServingDirtyWork')

type CountRow = {claimStateRows: number | string; dirtyWorkRows: number | string; idLookupRows: number | string}

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

const getOptionalValue = (value: string | undefined) => {
  return value === undefined || value === '' ? null : value
}

const getOptionalLimit = (value: string | undefined) => {
  const raw = getOptionalValue(value)

  if (raw === null) {
    return null
  }

  const parsed = Number(raw)

  return Number.isSafeInteger(parsed) ? parsed : Number.NaN
}

export const getDeleteOrphanReviewServingDirtyWorkCliOptions = (
  argv: readonly string[] = process.argv.slice(2),
): DeleteOrphanReviewServingDirtyWorkCliOptions => {
  return {
    acknowledgement: getOptionalValue(getArgValue(argv, ['--ack', '--acknowledgement'])),
    apply: hasFlag(argv, '--apply') && !hasFlag(argv, '--dry-run'),
    createdBefore: getOptionalValue(getArgValue(argv, ['--created-before', '--createdBefore'])),
    limit: getOptionalLimit(getArgValue(argv, ['--limit'])),
    projectId: getOptionalValue(getArgValue(argv, ['--project-id', '--projectId'])),
  }
}

/** Returns the ISO-8601 UTC instant for a parseable timestamp, or null when it is not parseable. */
export const getNormalizedCreatedBefore = (value: string | null) => {
  if (value === null) {
    return null
  }

  const parsedMs = Date.parse(value)

  return Number.isNaN(parsedMs) ? null : new Date(parsedMs).toISOString()
}

export const getDeleteOrphanReviewServingDirtyWorkRefusalReasons = (
  options: DeleteOrphanReviewServingDirtyWorkCliOptions,
) => {
  return [
    ...(options.projectId === null ? ['missing_project_id'] : []),
    ...(options.apply && options.createdBefore === null ? ['missing_created_before'] : []),
    ...(options.createdBefore !== null && getNormalizedCreatedBefore(options.createdBefore) === null
      ? ['invalid_created_before']
      : []),
    ...(options.limit !== null && !(Number.isSafeInteger(options.limit) && options.limit > 0) ? ['invalid_limit'] : []),
    ...(options.apply && options.acknowledgement !== requiredApplyAcknowledgement
      ? ['missing_apply_acknowledgement']
      : []),
  ]
}

export const getOrphanReviewServingDirtyWorkSelectSql = (input: {
  createdBefore: string | null
  limit: number | null
  projectId: string
}) => {
  const createdBeforePredicate =
    input.createdBefore === null ? '' : `AND created_at < ${getSqlLiteral(input.createdBefore)}::TIMESTAMPTZ`
  const limitClause = input.limit === null ? '' : `ORDER BY created_at, dirty_work_id LIMIT ${input.limit}`

  return `
    SELECT dirty_work_id
    FROM app.review_serving_dirty_work
    WHERE project_id = ${getSqlLiteral(input.projectId)}
      AND status = 'pending'
      AND projection_component IS NULL
      ${createdBeforePredicate}
    ${limitClause}
  `
}

const getCountsSql = (doomedSql: string) => {
  return `
    SELECT
      (
        SELECT COUNT(*)
        FROM app.review_serving_dirty_work
        WHERE dirty_work_id IN (${doomedSql})
      ) AS dirtyWorkRows,
      (
        SELECT COUNT(*)
        FROM app.review_serving_dirty_work_claim_state
        WHERE dirty_work_id IN (${doomedSql})
      ) AS claimStateRows,
      (
        SELECT COUNT(*)
        FROM app.review_serving_dirty_work_id_lookup
        WHERE dirty_work_id IN (${doomedSql})
      ) AS idLookupRows
  `
}

const getCounts = async (
  doomedSql: string,
  database: ReviewServingDirtyWorkTransaction,
): Promise<DeleteOrphanReviewServingDirtyWorkCounts> => {
  const [row] = await database.queryJson<CountRow>(getCountsSql(doomedSql))

  return {
    claimStateRows: Number(row?.claimStateRows ?? 0),
    dirtyWorkRows: Number(row?.dirtyWorkRows ?? 0),
    idLookupRows: Number(row?.idLookupRows ?? 0),
  }
}

const hasOrphanRows = (counts: DeleteOrphanReviewServingDirtyWorkCounts) => {
  return counts.dirtyWorkRows > 0 || counts.claimStateRows > 0 || counts.idLookupRows > 0
}

export const countOrphanReviewServingDirtyWork = async (
  input: {createdBefore: string | null; limit: number | null; projectId: string},
  database: ReviewServingDirtyWorkTransaction,
) => {
  return getCounts(getOrphanReviewServingDirtyWorkSelectSql(input), database)
}

export const deleteOrphanReviewServingDirtyWork = async (
  input: {createdBefore: string; limit: number | null; projectId: string},
  tx: ReviewServingDirtyWorkTransaction,
): Promise<DeleteOrphanReviewServingDirtyWorkCounts> => {
  const doomedSql = `SELECT dirty_work_id FROM ${orphanDirtyWorkTempTable}`

  await tx.run(`DROP TABLE IF EXISTS ${orphanDirtyWorkTempTable}`)
  await tx.run(`
    CREATE TEMP TABLE ${orphanDirtyWorkTempTable} AS
    ${getOrphanReviewServingDirtyWorkSelectSql(input)}
  `)

  const counts = await getCounts(doomedSql, tx)

  await tx.run(`
    DELETE FROM app.review_serving_dirty_work_claim_state
    WHERE dirty_work_id IN (${doomedSql})
  `)
  await tx.run(`
    DELETE FROM app.review_serving_dirty_work_id_lookup
    WHERE dirty_work_id IN (${doomedSql})
  `)
  await tx.run(`
    DELETE FROM app.review_serving_dirty_work
    WHERE dirty_work_id IN (${doomedSql})
  `)
  await tx.run(`DROP TABLE IF EXISTS ${orphanDirtyWorkTempTable}`)

  return counts
}

const getMaintenanceDatabase = (): ReviewServingDirtyWorkDatabase => {
  const database = getAppDatabaseService()

  return {
    queryJson: <T>(statement: string) => {
      return database.queryJson<T>(statement, workloadContext)
    },
    run: (statement: string) => {
      return database.run(statement, workloadContext)
    },
    transaction: <T>(operation: (tx: ReviewServingDirtyWorkTransaction) => Promise<T>) => {
      return database.transaction(operation, workloadContext)
    },
  }
}

export const runDeleteOrphanReviewServingDirtyWork = async (
  options: DeleteOrphanReviewServingDirtyWorkCliOptions,
  database: ReviewServingDirtyWorkDatabase,
): Promise<DeleteOrphanReviewServingDirtyWorkCliResult> => {
  const refusalReasons = getDeleteOrphanReviewServingDirtyWorkRefusalReasons(options)
  const createdBefore = getNormalizedCreatedBefore(options.createdBefore)
  const base = {
    acknowledgementRequiredForApply: requiredApplyAcknowledgement,
    createdBefore,
    limit: options.limit,
    mode,
    projectId: options.projectId,
  }

  if (refusalReasons.length > 0) {
    return {...base, applied: false, refusalReasons, result: null, status: 'refused'}
  }

  const projectId = options.projectId ?? ''
  const dryRun = await countOrphanReviewServingDirtyWork({createdBefore, limit: options.limit, projectId}, database)

  if (!options.apply) {
    return {...base, applied: false, refusalReasons: [], result: dryRun, status: 'dry_run'}
  }

  if (createdBefore === null || !hasOrphanRows(dryRun)) {
    return {
      ...base,
      applied: false,
      applyPreflight: dryRun,
      applySkippedReason: 'no_orphan_dirty_work',
      refusalReasons: [],
      result: dryRun,
      status: 'dry_run',
    }
  }

  const applied = await database.transaction((tx) => {
    return deleteOrphanReviewServingDirtyWork({createdBefore, limit: options.limit, projectId}, tx)
  })

  return {
    ...base,
    applied: hasOrphanRows(applied),
    applyPreflight: dryRun,
    refusalReasons: [],
    result: applied,
    status: 'applied',
  }
}

const deleteOrphanReviewServingDirtyWorkCli = async () => {
  const options = getDeleteOrphanReviewServingDirtyWorkCliOptions()
  const refusalReasons = getDeleteOrphanReviewServingDirtyWorkRefusalReasons(options)

  if (refusalReasons.includes('missing_project_id')) {
    console.error('Missing required --project-id=<project-id>')
    process.exitCode = 1
    return
  }

  if (refusalReasons.includes('missing_created_before')) {
    console.error('Missing required --created-before=<ISO timestamp> for --apply')
    process.exitCode = 1
    return
  }

  if (refusalReasons.includes('invalid_created_before')) {
    console.error(`Invalid --created-before timestamp: ${options.createdBefore ?? ''}`)
    process.exitCode = 1
    return
  }

  if (refusalReasons.includes('invalid_limit')) {
    console.error('Invalid --limit; expected a positive integer')
    process.exitCode = 1
    return
  }

  if (refusalReasons.includes('missing_apply_acknowledgement')) {
    console.error(`Refusing --apply without --ack=${requiredApplyAcknowledgement}`)
    process.exitCode = 1
    return
  }

  await withDuckdbMaintenanceAccess('delete orphan review-serving dirty work', async () => {
    const result = await runDeleteOrphanReviewServingDirtyWork(options, getMaintenanceDatabase())

    if (result.status === 'refused' || (options.apply && !result.applied)) {
      process.exitCode = 1
    }

    console.log(JSON.stringify(result, null, 2))
  })
}

if (import.meta.main) {
  await deleteOrphanReviewServingDirtyWorkCli()
}
