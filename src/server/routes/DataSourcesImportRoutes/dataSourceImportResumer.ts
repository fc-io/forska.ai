import {
  dataSourceImportMaxConsecutiveFailures,
  type DataSourceImportResumeCandidate,
  type DataSourceImportStateRepository,
  type DataSourceImportTrigger,
  getDataSourceImportStateRepository,
} from '../../services/dataSourceImportStateRepository.ts'
import {HttpError} from '../../utils/httpError.ts'
import {writeRuntimeFailureLogEvent, writeRuntimeOperatorLogEvent} from '../../utils/runtimeLogger.ts'
import {dataSourcesImportRoutesPostArxiv} from './dataSourcesImportRoutesPostArxiv.ts'
import {dataSourcesImportRoutesPostBiorxiv} from './dataSourcesImportRoutesPostBiorxiv.ts'
import {dataSourcesImportRoutesPostEuropePmcPpr} from './dataSourcesImportRoutesPostEuropePmcPpr.ts'
import {dataSourcesImportRoutesPostMedrxiv} from './dataSourcesImportRoutesPostMedrxiv.ts'
import {dataSourcesImportRoutesPostPubmed} from './dataSourcesImportRoutesPostPubmed.ts'
import {isDataSourceImportRunningInProcess} from './startDataSourceImportInBackground.ts'

type DataSourceImportStarter = (body: {id: string}, options: {trigger?: DataSourceImportTrigger}) => Promise<unknown>
type DataSourceImportResumerRepository = Pick<
  DataSourceImportStateRepository,
  'listResumeCandidates' | 'markRunFailed' | 'markRunStopped'
>
type DataSourceImportResumeAttempt =
  | {dataSourceId: string; outcome: 'failed'; error: string}
  | {dataSourceId: string; outcome: 'skipped'; reason: string}
  | {dataSourceId: string; outcome: 'started'; trigger: DataSourceImportTrigger}

export type DataSourceImportResumerWakeResult = {attempts: DataSourceImportResumeAttempt[]; stopped: string[]}

const dataSourceImportStartersByRoute: Record<string, DataSourceImportStarter> = {
  '/api/datasources/import/arxiv': dataSourcesImportRoutesPostArxiv,
  '/api/datasources/import/biorxiv': dataSourcesImportRoutesPostBiorxiv,
  '/api/datasources/import/europe-pmc-ppr': dataSourcesImportRoutesPostEuropePmcPpr,
  '/api/datasources/import/medrxiv': dataSourcesImportRoutesPostMedrxiv,
  '/api/datasources/import/pubmed': dataSourcesImportRoutesPostPubmed,
}

const getResumeTrigger = (candidate: DataSourceImportResumeCandidate): DataSourceImportTrigger => {
  return candidate.status === 'running' ? 'auto_resume' : 'auto_retry'
}

const isInterruptedTooOften = (candidate: DataSourceImportResumeCandidate) => {
  return candidate.status === 'running' && candidate.consecutiveFailureCount >= dataSourceImportMaxConsecutiveFailures
}

export const startDataSourceImportForResume = async (
  candidate: DataSourceImportResumeCandidate,
  trigger: DataSourceImportTrigger,
) => {
  const starter = dataSourceImportStartersByRoute[candidate.importRoute]

  if (!starter) {
    throw new Error(`Automatic resume is not supported for import route ${candidate.importRoute}`)
  }

  await starter({id: candidate.dataSourceId}, {trigger})
}

const getErrorMessage = (error: unknown) => {
  return error instanceof Error ? error.message : String(error)
}

const stopInterruptedImports = async (
  repository: DataSourceImportResumerRepository,
  candidates: DataSourceImportResumeCandidate[],
  now: Date,
) => {
  await candidates.reduce(async (previous, candidate) => {
    await previous
    await repository.markRunStopped({
      dataSourceId: candidate.dataSourceId,
      error:
        `The import was interrupted ${candidate.consecutiveFailureCount} times in a row without storing a page, `
        + 'so automatic resume stopped. Resume continues from the saved cursor.',
      now,
    })
    writeRuntimeOperatorLogEvent({
      attrs: {consecutiveFailureCount: candidate.consecutiveFailureCount, dataSourceId: candidate.dataSourceId},
      event: 'data-source-import.auto-resume-stopped',
      message: `[dataSourceImport] stopped resuming data source ${candidate.dataSourceId} after repeated interruptions`,
      severity: 'WARN',
    })
  }, Promise.resolve())
}

const recordResumeStartFailure = async (
  repository: DataSourceImportResumerRepository,
  candidate: DataSourceImportResumeCandidate,
  error: unknown,
  now: Date,
): Promise<DataSourceImportResumeAttempt> => {
  await repository.markRunFailed({dataSourceId: candidate.dataSourceId, error, now})
  writeRuntimeFailureLogEvent({
    attrs: {dataSourceId: candidate.dataSourceId, error},
    event: 'data-source-import.auto-resume-failed',
    message: `[dataSourceImport] could not resume data source ${candidate.dataSourceId}`,
    severity: 'WARN',
    terminalArgs: [getErrorMessage(error)],
  })

  return {dataSourceId: candidate.dataSourceId, error: getErrorMessage(error), outcome: 'failed'}
}

const tryResumeCandidates = async (input: {
  attempts: DataSourceImportResumeAttempt[]
  candidates: DataSourceImportResumeCandidate[]
  now: Date
  repository: DataSourceImportResumerRepository
  startImport: typeof startDataSourceImportForResume
}): Promise<DataSourceImportResumeAttempt[]> => {
  const [candidate, ...remaining] = input.candidates

  if (!candidate) {
    return input.attempts
  }

  const trigger = getResumeTrigger(candidate)
  const attempt = await input.startImport(candidate, trigger).then(
    (): DataSourceImportResumeAttempt => {
      return {dataSourceId: candidate.dataSourceId, outcome: 'started', trigger}
    },
    async (error: unknown): Promise<DataSourceImportResumeAttempt> => {
      return error instanceof HttpError && error.status === 409
        ? {dataSourceId: candidate.dataSourceId, outcome: 'skipped', reason: error.message}
        : await recordResumeStartFailure(input.repository, candidate, error, input.now)
    },
  )
  const attempts = [...input.attempts, attempt]

  return attempt.outcome === 'skipped'
    ? await tryResumeCandidates({...input, attempts, candidates: remaining})
    : attempts
}

export const runDataSourceImportResumerWake = async ({
  isImportRunning = isDataSourceImportRunningInProcess,
  now = new Date(),
  repository = getDataSourceImportStateRepository(),
  startImport = startDataSourceImportForResume,
}: {
  isImportRunning?: (dataSourceId: string) => boolean
  now?: Date
  repository?: DataSourceImportResumerRepository
  startImport?: typeof startDataSourceImportForResume
} = {}): Promise<DataSourceImportResumerWakeResult> => {
  const candidates = (await repository.listResumeCandidates({now})).filter((candidate) => {
    return !isImportRunning(candidate.dataSourceId)
  })
  const interruptedTooOften = candidates.filter(isInterruptedTooOften)
  const resumable = candidates.filter((candidate) => {
    return !isInterruptedTooOften(candidate)
  })

  await stopInterruptedImports(repository, interruptedTooOften, now)
  const attempts = await tryResumeCandidates({attempts: [], candidates: resumable, now, repository, startImport})

  return {
    attempts,
    stopped: interruptedTooOften.map((candidate) => {
      return candidate.dataSourceId
    }),
  }
}
