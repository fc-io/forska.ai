import {apiClient} from './apiClient.ts'
import {handleApiResponse} from './utils/handleApiResponse'

export type JudgmentJobRepairAction = 'checkpoint' | 'drain' | 'preflight' | 'quarantine' | 'repair' | 'unquarantine'
export type JudgmentJobPromptStats = {claimed: number; judged: number; ready: number; running: number; skipped: number}
export type JudgmentJobRequestStats = {
  attempts: number
  endpointAvailability?: {
    cooldownRemainingMs: number | null
    lastFailureKind: string | null
    lastFailureMessage: string | null
    probeInProgress: boolean
    status: string
  } | null
  inFlight: number
}

type JudgmentJobRepairResponse = {
  action: JudgmentJobRepairAction
  changes: {
    checkpointed: boolean
    deletedOrphanedJudgedRows: number
    finalizedDrain: boolean
    importedOutboxRows: number
    initializedSqlite: boolean
    prunedOutboxRows: number
    prunedQueueRows: number
    quarantined: boolean
    reapedOutboxClaims: number
    requeuedOrphanedJudgedRows: number
    requeuedSentPrompts: number
    unquarantined: boolean
  }
  job: {
    id: string
    status: string
    storageState: string
    quarantinedAt: string | null
    quarantineReason: string | null
    lastImportStartedAt: string | null
    lastImportCompletedAt: string | null
    lastImportErrorAt: string | null
    lastImportError: string | null
    lastImportExitCode: number | null
    importFailureCount: number
    pauseRequestedAt: string | null
    updatedAt: string | null
  }
  jobId: string
  liveSqlite: {
    claimedOutboxCount: number
    lastAckSeq: number | null
    oldestUnexportedAgeMs: number | null
    outboxRowCount: number
    promptCounts: {claimed: number; judged: number; ready: number; running: number; skipped: number}
    retainedRowCount: number
    sqliteFileBytes: number | null
    walBytes: number
  }
  message: string
  ok: boolean
  preflight: {ok: boolean} | null
  requestedBy: string
  systemSqliteFallback: {
    requestedSteps: Array<'checkpoint' | 'diagnostic' | 'export'>
    results: Array<{
      command: string[]
      exitCode: number
      exportBytes: number | null
      exportPath: string | null
      ok: boolean
      stderr: string
      step: 'checkpoint' | 'diagnostic' | 'export'
      stdout: string
      walBytesAfter: number | null
      walBytesBefore: number | null
    }>
  }
}

const buildMissingJob = () => {
  return {
    id: 'not found',
    createdAt: '',
    updatedAt: '',
    projectId: 'not found',
    status: '',
    storageState: 'missing',
    quarantinedAt: null,
    quarantineReason: null,
    lastImportStartedAt: null,
    lastImportCompletedAt: null,
    lastImportErrorAt: null,
    lastImportError: null,
    lastImportExitCode: null,
    importFailureCount: 0,
    pauseRequestedAt: null,
    error: '',
    projectName: '',
    promptStats: {claimed: 0, ready: 0, running: 0, judged: 0, skipped: 0} satisfies JudgmentJobPromptStats,
    requestStats: {attempts: 0, endpointAvailability: null, inFlight: 0} satisfies JudgmentJobRequestStats,
  }
}

export const createJudgmentsJob = async (projectId: string, agentConfig?: unknown) => {
  const response = await apiClient.api.judgmentsjobs.post({projectId, agentConfig})
  return handleApiResponse(response, 'Failed to create judgments job')
}

export const fetchJudgmentsJobs = async () => {
  const response = await apiClient.api.judgmentsjobs.get({query: {}})
  const result = handleApiResponse(response, 'Failed to fetch judgment jobs')
  return result && result.data ? result.data : []
}

export const getJudgmentsJobById = async (jobId: string) => {
  const response = await apiClient.api.judgmentsjobs({id: jobId}).get()
  const result = handleApiResponse(response, 'Failed to fetch job state')
  return result ? result : buildMissingJob()
}

export const getAllJudgmentsJobs = async () => {
  const response = await apiClient.api.judgmentsjobs.get()
  return handleApiResponse(response, 'Failed to fetch all jobs')
}

export const updateJudgmentsJobStatus = async (
  jobId: string,
  status:
    | 'not_started'
    | 'waiting_on_llm_connection'
    | 'waiting_on_db_connection'
    | 'running'
    | 'paused'
    | 'failed'
    | 'completed'
    | 'project_removed',
) => {
  const response = await apiClient.api.judgmentsjobs({id: jobId}).patch({status})
  return handleApiResponse(response, 'Failed to update job status')
}

export const pauseJudgmentsJob = (jobId: string) => {
  return updateJudgmentsJobStatus(jobId, 'paused')
}

export const startJudgmentsJob = (jobId: string) => {
  return updateJudgmentsJobStatus(jobId, 'running')
}

export const deleteJudgmentsJob = async (jobId: string) => {
  const response = await apiClient.api.judgmentsjobs({id: jobId}).delete()
  return handleApiResponse(response, 'Failed to delete job')
}

export const getJudgmentsJobUnassessedArticles = async (jobId: string) => {
  const response = await apiClient.api['judgmentsjobs-unassessed-articles'].get({query: {jobId}})
  const result = handleApiResponse(response, 'Failed to fetch unassessed articles for job')
  return result?.data ?? []
}

export const getTotalTokenUsage = async () => {
  const response = await apiClient.api['judgmentsjobs-total-token-usage'].get()
  const result = handleApiResponse(response, 'Failed to fetch total token usage')
  return result?.data ?? {totalTokens: 0, totalPromptTokens: 0, totalCompletionTokens: 0}
}

export const runJudgmentsJobRepairAction = async ({
  action,
  jobId,
  reason,
}: {
  action: JudgmentJobRepairAction
  jobId: string
  reason?: string
}) => {
  const response =
    action === 'preflight'
      ? await apiClient.api.judgmentsjobs({id: jobId}).preflight.post()
      : action === 'drain'
        ? await apiClient.api.judgmentsjobs({id: jobId}).drain.post({})
        : action === 'checkpoint'
          ? await apiClient.api.judgmentsjobs({id: jobId}).checkpoint.post({})
          : action === 'quarantine'
            ? await apiClient.api.judgmentsjobs({id: jobId}).quarantine.post({reason})
            : action === 'unquarantine'
              ? await apiClient.api.judgmentsjobs({id: jobId}).unquarantine.post()
              : await apiClient.api.judgmentsjobs({id: jobId}).repair.post({})

  const result = handleApiResponse(response, `Failed to ${action} local storage`)
  return ('data' in result ? result.data : result) as JudgmentJobRepairResponse
}
