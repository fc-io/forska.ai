import type {
  ReviewServingChunkManifestRepositoryDatabase,
  ReviewServingChunkManifestRepositoryTransaction,
} from '../src/server/reviewServing/reviewServingChunkManifestRepository.ts'
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
        acknowledgementRequiredForApply: requiredApplyAcknowledgement,
        applyRequirement: 'dry-run preflight must report an empty refusalReasons array',
        mode: 'failed_requestless_chunk_release',
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

  const projectId = options.projectId
  const requestId = options.requestId

  await withDuckdbMaintenanceAccess('release failed requestless review-serving rebuild chunks', async () => {
    const database = getMaintenanceDatabase()

    if (!options.apply) {
      const result = await releaseFailedRequestlessReviewServingRebuildChunks({projectId, requestId}, database)

      printResult(result)
      return
    }

    const applyPreflight = await releaseFailedRequestlessReviewServingRebuildChunks({projectId, requestId}, database)

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

    const result = await releaseFailedRequestlessReviewServingRebuildChunks(
      {apply: true, projectId, requestId},
      database,
    )

    if (!result.applied || result.refusalReasons.length > 0) {
      process.exitCode = 1
    }

    printResult({...result, applyPreflight})
  })
}

await releaseFailedRequestlessReviewServingRebuildChunksCli()
