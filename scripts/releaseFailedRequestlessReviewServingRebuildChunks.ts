import {releaseFailedRequestlessReviewServingRebuildChunks} from '../src/server/reviewServing/reviewServingRebuildRequestRepository.ts'
import {getAppDatabaseService} from '../src/server/services/appDatabaseService.ts'
import {withDuckdbMaintenanceAccess} from '../src/server/utils/duckdbScriptAccess.ts'
import {getMaintenanceDuckdbWorkloadContext} from '../src/server/utils/duckdbService.ts'

type CliOptions = {acknowledgement: string | null; apply: boolean; projectId: string | null; requestId: string | null}

const requiredApplyAcknowledgement = 'release-failed-requestless-review-rebuild-chunks-preserve-request-row'
const workloadContext = getMaintenanceDuckdbWorkloadContext('releaseFailedRequestlessReviewServingRebuildChunks')

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

const getCliOptions = (): CliOptions => {
  return {
    acknowledgement: getArgValue(['--ack', '--acknowledgement']) ?? null,
    apply: hasFlag('--apply'),
    projectId: getArgValue(['--project-id', '--projectId']) ?? null,
    requestId: getArgValue(['--request-id', '--requestId']) ?? null,
  }
}

const releaseFailedRequestlessReviewServingRebuildChunksCli = async () => {
  const options = getCliOptions()

  if (options.apply && !options.projectId) {
    console.error('Missing required --project-id=<project-id> for --apply')
    process.exitCode = 1
    return
  }

  if (options.apply && !options.requestId) {
    console.error('Missing required --request-id=<request-id> for --apply')
    process.exitCode = 1
    return
  }

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

  await withDuckdbMaintenanceAccess('release failed requestless review-serving rebuild chunks', async () => {
    const database = getAppDatabaseService()
    const result = await releaseFailedRequestlessReviewServingRebuildChunks(
      {apply: options.apply, projectId: options.projectId, requestId: options.requestId},
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
        {
          ...result,
          acknowledgementRequiredForApply: requiredApplyAcknowledgement,
          mode: 'failed_requestless_chunk_release',
        },
        null,
        2,
      ),
    )
  })
}

await releaseFailedRequestlessReviewServingRebuildChunksCli()
