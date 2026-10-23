import type {JudgmentJobMutationState} from '../../cron/judgmentsJobs/judgmentJobStatusMutation.ts'
import {getDateValue, getJsonValue} from '../../services/appQueryHelpers.ts'
import {getJudgmentJobStopFields} from './getJudgmentJobStopFields.ts'

export const getJudgmentJobMutationResponse = (job: JudgmentJobMutationState) => {
  return {
    jobId: job.id,
    status: job.status,
    storageState: job.storageState,
    quarantinedAt: getDateValue(job.quarantinedAt),
    quarantineReason: job.quarantineReason,
    lastImportStartedAt: getDateValue(job.lastImportStartedAt),
    lastImportCompletedAt: getDateValue(job.lastImportCompletedAt),
    lastImportErrorAt: getDateValue(job.lastImportErrorAt),
    lastImportError: job.lastImportError,
    lastImportExitCode: job.lastImportExitCode,
    importFailureCount: Number(job.importFailureCount ?? 0),
    pauseRequestedAt: getDateValue(job.pauseRequestedAt),
    updatedAt: getDateValue(job.updatedAt),
    error: getJsonValue(job.error) as string[] | null,
    ...getJudgmentJobStopFields(job),
  }
}
