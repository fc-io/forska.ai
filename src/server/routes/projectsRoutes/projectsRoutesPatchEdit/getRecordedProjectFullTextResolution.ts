import {HttpError} from '../../../utils/httpError.ts'
import {
  fullTextStrategyRecordableJobStatuses,
  fullTextStrategyRecordJobRunningErrorMessage,
  fullTextStrategyRecordWithoutFullTextErrorMessage,
  type ProjectFullTextResolution,
  type ProjectFullTextSettings,
  resolveProjectFullTextSettingsOrThrow,
} from '../projectFullTextSettings.ts'
import type {ProjectEditJudgmentJob} from './projectEditTypes.ts'

export const getRecordedProjectFullTextResolution = async ({
  currentFullTextSettings,
  job,
  modelId,
  useFulltext,
}: {
  currentFullTextSettings: ProjectFullTextSettings
  job: ProjectEditJudgmentJob
  modelId: string
  useFulltext: boolean
}): Promise<ProjectFullTextResolution> => {
  if (!fullTextStrategyRecordableJobStatuses.has(job.status)) {
    throw new HttpError(409, fullTextStrategyRecordJobRunningErrorMessage)
  }

  if (!useFulltext || !currentFullTextSettings.fullTextFigureMode || !currentFullTextSettings.fullTextChunkPolicy) {
    throw new HttpError(400, fullTextStrategyRecordWithoutFullTextErrorMessage)
  }

  return resolveProjectFullTextSettingsOrThrow(
    {
      fullTextChunkPolicy: currentFullTextSettings.fullTextChunkPolicy,
      fullTextFigureMode: currentFullTextSettings.fullTextFigureMode,
      useFulltext,
    },
    modelId,
  )
}
