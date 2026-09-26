import {
  type DataSourceImportStateRepository,
  type DataSourceImportTrigger,
  getDataSourceImportStateRepository,
} from '../../services/dataSourceImportStateRepository.ts'
import {HttpError} from '../../utils/httpError.ts'
import {writeRuntimeFailureLogEvent, writeRuntimeOperatorLogEvent} from '../../utils/runtimeLogger.ts'

type DataSourceImportStateStore = Pick<DataSourceImportStateRepository, 'markRunFailed' | 'markRunStarted'>

type DataSourceImportRun = {
  dataSourceId: string
  importRoute: string
  runImport: (markImportStarted: () => Promise<void>) => Promise<unknown>
  startsFresh: boolean
  stateStore?: DataSourceImportStateStore
  trigger: DataSourceImportTrigger
}

const runningDataSourceImportIds = new Set<string>()

export const isDataSourceImportRunningInProcess = (dataSourceId: string) => {
  return runningDataSourceImportIds.has(dataSourceId)
}

const getDataSourceImportLogAttrs = (input: DataSourceImportRun, startedAtMs: number) => {
  return {
    dataSourceId: input.dataSourceId,
    durationMs: Date.now() - startedAtMs,
    importRoute: input.importRoute,
    trigger: input.trigger,
  }
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
    attrs: {
      dataSourceId: input.dataSourceId,
      importRoute: input.importRoute,
      startsFresh: input.startsFresh,
      trigger: input.trigger,
    },
    event: 'data-source-import.started',
    message: `[dataSourceImport] import started in the background for data source ${input.dataSourceId}`,
    severity: 'INFO',
  })
}

const recordDataSourceImportFailure = async (
  input: DataSourceImportRun,
  stateStore: DataSourceImportStateStore,
  error: unknown,
) => {
  await stateStore.markRunFailed({dataSourceId: input.dataSourceId, error, now: new Date()}).catch((stateError) => {
    writeRuntimeFailureLogEvent({
      attrs: {dataSourceId: input.dataSourceId, error, stateError},
      event: 'data-source-import.state-write-failed',
      message: `[dataSourceImport] could not record the failed import for data source ${input.dataSourceId}`,
      terminalArgs: [stateError],
    })
  })
}

const runDataSourceImport = async (
  input: DataSourceImportRun,
  stateStore: DataSourceImportStateStore,
  importState: {started: boolean},
  markImportStarted: () => Promise<void>,
) => {
  try {
    await input.runImport(markImportStarted)
  } catch (error) {
    if (importState.started) {
      await recordDataSourceImportFailure(input, stateStore, error)
    }
    throw error
  } finally {
    runningDataSourceImportIds.delete(input.dataSourceId)
  }
}

export const startDataSourceImportInBackground = async (input: DataSourceImportRun) => {
  if (runningDataSourceImportIds.has(input.dataSourceId)) {
    throw new HttpError(409, 'An import is already running for this data source')
  }

  runningDataSourceImportIds.add(input.dataSourceId)
  const stateStore = input.stateStore ?? getDataSourceImportStateRepository()
  const startedAtMs = Date.now()
  const importState = {started: false}
  const importStart = Promise.withResolvers<undefined>()
  const importRun = runDataSourceImport(input, stateStore, importState, async () => {
    await stateStore.markRunStarted({
      dataSourceId: input.dataSourceId,
      importRoute: input.importRoute,
      now: new Date(),
      startsFresh: input.startsFresh,
      trigger: input.trigger,
    })
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
