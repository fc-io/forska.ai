import type {
  ReviewServingChunkManifestRepositoryDatabase,
  ReviewServingChunkManifestRepositoryTransaction,
} from '../src/server/reviewServing/reviewServingChunkManifestRepository.ts'
import {
  terminalizeStaleZeroChunkReviewServingRebuildRequest,
  terminalizeSupersededProjectScopedReviewServingRebuildRequest,
} from '../src/server/reviewServing/reviewServingRebuildRequestRepository.ts'
import {getAppDatabaseService} from '../src/server/services/appDatabaseService.ts'
import {withDuckdbMaintenanceAccess} from '../src/server/utils/duckdbScriptAccess.ts'
import {getMaintenanceDuckdbWorkloadContext} from '../src/server/utils/duckdbService.ts'

type TerminalizationMode = 'superseded_project_scoped' | 'zero_chunks'
type CliOptions = {
  acknowledgement: string | null
  apply: boolean
  minimumAgeMinutes: number
  mode: TerminalizationMode
  projectId: string | null
  requestId: string | null
}

const applyAcknowledgements = {
  superseded_project_scoped: 'cancel-superseded-project-scoped-review-rebuild-request-preserve-evidence',
  zero_chunks: 'fail-stale-zero-chunk-review-rebuild-request-no-cleanup-authorized',
} as const satisfies Record<TerminalizationMode, string>
const workloadContext = getMaintenanceDuckdbWorkloadContext('terminalizeReviewServingRebuildRequest')

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

const getTerminalizationMode = (value: string | undefined): TerminalizationMode => {
  return value === 'superseded_project_scoped' ? 'superseded_project_scoped' : 'zero_chunks'
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
  const mode = getTerminalizationMode(getArgValue(['--mode']))

  console.log(
    JSON.stringify(
      {
        ...(typeof result === 'object' && result !== null ? result : {result}),
        acknowledgementRequiredForApply: applyAcknowledgements[mode],
        applyRequirement: 'dry-run preflight must report an empty refusalReasons array',
        mode,
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
    minimumAgeMinutes: getNonNegativeIntegerOption(getArgValue(['--minimum-age-minutes']), 60),
    mode: getTerminalizationMode(getArgValue(['--mode'])),
    projectId: getArgValue(['--project-id', '--projectId']) ?? null,
    requestId: getArgValue(['--request-id', '--requestId']) ?? null,
  }
}

const runTerminalizationPreflight = (
  options: CliOptions,
  database: ReviewServingChunkManifestRepositoryDatabase,
  apply = false,
) => {
  const input = {
    apply,
    minimumAgeMinutes: options.minimumAgeMinutes,
    projectId: options.projectId ?? '',
    requestId: options.requestId ?? '',
  }

  return options.mode === 'superseded_project_scoped'
    ? terminalizeSupersededProjectScopedReviewServingRebuildRequest(input, database)
    : terminalizeStaleZeroChunkReviewServingRebuildRequest(input, database)
}

const terminalizeReviewServingRebuildRequestCli = async () => {
  const options = getCliOptions()

  if (!options.projectId) {
    console.error('Missing required --project-id=<project-id>')
    process.exitCode = 1
    return
  }

  if (!options.requestId) {
    console.error('Missing required --request-id=<request-id>')
    process.exitCode = 1
    return
  }

  const requiredApplyAcknowledgement = applyAcknowledgements[options.mode]

  if (options.apply && options.acknowledgement !== requiredApplyAcknowledgement) {
    console.error(`Refusing --apply without --ack=${requiredApplyAcknowledgement}`)
    process.exitCode = 1
    return
  }

  await withDuckdbMaintenanceAccess('terminalize review-serving rebuild request', async () => {
    const database = getMaintenanceDatabase()

    if (!options.apply) {
      const result = await runTerminalizationPreflight(options, database)

      printResult(result)
      return
    }

    const applyPreflight = await runTerminalizationPreflight(options, database)

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

    const result = await runTerminalizationPreflight(options, database, true)

    if (!result.applied || result.refusalReasons.length > 0) {
      process.exitCode = 1
    }

    printResult({...result, applyPreflight})
  })
}

await terminalizeReviewServingRebuildRequestCli()
