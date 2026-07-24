import {terminalizeStaleZeroChunkReviewServingRebuildRequest} from '../src/server/reviewServing/reviewServingRebuildRequestRepository.ts'
import {getAppDatabaseService} from '../src/server/services/appDatabaseService.ts'
import {withDuckdbMaintenanceAccess} from '../src/server/utils/duckdbScriptAccess.ts'
import {getMaintenanceDuckdbWorkloadContext} from '../src/server/utils/duckdbService.ts'

type CliOptions = {
  acknowledgement: string | null
  apply: boolean
  minimumAgeMinutes: number
  projectId: string | null
  requestId: string | null
}

const requiredApplyAcknowledgement = 'fail-stale-zero-chunk-review-rebuild-request-no-cleanup-authorized'
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

const getCliOptions = (): CliOptions => {
  return {
    acknowledgement: getArgValue(['--ack', '--acknowledgement']) ?? null,
    apply: hasFlag('--apply'),
    minimumAgeMinutes: getNonNegativeIntegerOption(getArgValue(['--minimum-age-minutes']), 60),
    projectId: getArgValue(['--project-id', '--projectId']) ?? null,
    requestId: getArgValue(['--request-id', '--requestId']) ?? null,
  }
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

  if (options.apply && options.acknowledgement !== requiredApplyAcknowledgement) {
    console.error(`Refusing --apply without --ack=${requiredApplyAcknowledgement}`)
    process.exitCode = 1
    return
  }

  await withDuckdbMaintenanceAccess('terminalize review-serving rebuild request', async () => {
    const database = getAppDatabaseService()
    const result = await terminalizeStaleZeroChunkReviewServingRebuildRequest(
      {
        apply: options.apply,
        minimumAgeMinutes: options.minimumAgeMinutes,
        projectId: options.projectId,
        requestId: options.requestId,
      },
      {
        ...database,
        queryJson: <T>(statement: string) => {
          return database.queryJson<T>(statement, workloadContext)
        },
        run: (statement: string) => {
          return database.run(statement, workloadContext)
        },
        transaction: <T>(
          operation: (tx: {
            queryJson: <R>(statement: string) => Promise<R[]>
            run: (statement: string) => Promise<void>
          }) => Promise<T>,
        ) => {
          return database.transaction(operation, workloadContext)
        },
      },
    )

    console.log(
      JSON.stringify(
        {...result, acknowledgementRequiredForApply: requiredApplyAcknowledgement, mode: 'zero_chunks'},
        null,
        2,
      ),
    )
  })
}

await terminalizeReviewServingRebuildRequestCli()
