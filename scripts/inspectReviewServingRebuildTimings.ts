import {getReviewServingRebuildTimingDiagnostics} from '../src/server/reviewServing/reviewServingChunkManifestRepository.ts'
import {getAppDatabaseService} from '../src/server/services/appDatabaseService.ts'
import {withDuckdbMaintenanceAccess} from '../src/server/utils/duckdbScriptAccess.ts'
import {getMaintenanceDuckdbWorkloadContext} from '../src/server/utils/duckdbService.ts'

type CliOptions = {limit: number; projectId: string | null; requestId: string | null}

const workloadContext = getMaintenanceDuckdbWorkloadContext('inspectReviewServingRebuildTimings')

const getArgValue = (names: string[]) => {
  const matchedArgument = process.argv.slice(2).find((argument) => {
    return names.some((name) => {
      return argument.startsWith(`${name}=`)
    })
  })

  return matchedArgument?.slice(matchedArgument.indexOf('=') + 1).trim()
}

const getPositiveIntegerOption = (value: string | undefined, fallback: number) => {
  const parsedValue = value === undefined ? Number.NaN : Number(value)

  return Number.isInteger(parsedValue) && parsedValue > 0 ? parsedValue : fallback
}

const getCliOptions = (): CliOptions => {
  return {
    limit: getPositiveIntegerOption(getArgValue(['--limit']), 50),
    projectId: getArgValue(['--project-id', '--projectId']) ?? null,
    requestId: getArgValue(['--request-id', '--requestId']) ?? null,
  }
}

const inspectReviewServingRebuildTimingsCli = async () => {
  const options = getCliOptions()

  await withDuckdbMaintenanceAccess('inspect review-serving rebuild timings', async () => {
    const database = getAppDatabaseService()
    const diagnostics = await getReviewServingRebuildTimingDiagnostics(
      options,
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

    console.log(JSON.stringify(diagnostics, null, 2))
  })
}

await inspectReviewServingRebuildTimingsCli()
