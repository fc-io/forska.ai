import {HttpError} from '../../utils/httpError.ts'
import {writeRuntimeOperatorLogEvent} from '../../utils/runtimeLogger.ts'

type DataSourceImportRun = {
  dataSourceId: string
  importRoute: string
  runImport: (markImportStarted: () => void) => Promise<unknown>
}

const runningDataSourceImportIds = new Set<string>()

const getDataSourceImportLogAttrs = (input: DataSourceImportRun, startedAtMs: number) => {
  return {dataSourceId: input.dataSourceId, durationMs: Date.now() - startedAtMs, importRoute: input.importRoute}
}

const logDataSourceImportCompleted = (input: DataSourceImportRun, startedAtMs: number) => {
  writeRuntimeOperatorLogEvent({
    attrs: getDataSourceImportLogAttrs(input, startedAtMs),
    event: 'data-source-import.completed',
    message: `[dataSourceImport] import completed for data source ${input.dataSourceId}`,
    severity: 'INFO',
  })
}

const logDataSourceImportFailed = (
  input: DataSourceImportRun,
  startedAtMs: number,
  importState: {started: boolean},
  error: unknown,
) => {
  writeRuntimeOperatorLogEvent({
    attrs: {...getDataSourceImportLogAttrs(input, startedAtMs), error, started: importState.started},
    event: 'data-source-import.failed',
    message: `[dataSourceImport] import failed for data source ${input.dataSourceId}`,
    severity: 'ERROR',
    terminalArgs: [error],
  })
}

const logDataSourceImportStarted = (input: DataSourceImportRun) => {
  writeRuntimeOperatorLogEvent({
    attrs: {dataSourceId: input.dataSourceId, importRoute: input.importRoute},
    event: 'data-source-import.started',
    message: `[dataSourceImport] import started in the background for data source ${input.dataSourceId}`,
    severity: 'INFO',
  })
}

const runDataSourceImport = async (input: DataSourceImportRun, markImportStarted: () => void) => {
  try {
    await input.runImport(markImportStarted)
  } finally {
    runningDataSourceImportIds.delete(input.dataSourceId)
  }
}

export const startDataSourceImportInBackground = async (input: DataSourceImportRun) => {
  if (runningDataSourceImportIds.has(input.dataSourceId)) {
    throw new HttpError(409, 'An import is already running for this data source')
  }

  runningDataSourceImportIds.add(input.dataSourceId)
  const startedAtMs = Date.now()
  const importState = {started: false}
  const importStart = Promise.withResolvers<undefined>()
  const importRun = runDataSourceImport(input, () => {
    importState.started = true
    logDataSourceImportStarted(input)
    importStart.resolve(undefined)
  })

  void importRun.then(
    () => {
      logDataSourceImportCompleted(input, startedAtMs)
    },
    (error) => {
      logDataSourceImportFailed(input, startedAtMs, importState, error)
    },
  )
  await Promise.race([importStart.promise, importRun])
}
