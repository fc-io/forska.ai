import {getJudgmentJobSqliteService} from '../cron/judgmentsJobs/judgmentJobSqliteService.ts'
import {
  getModelContextWindowMissingError,
  type ModelContextWindowMissingError,
} from '../providers/providerModelCapabilities.ts'
import {HttpError} from '../utils/httpError.ts'
import {getAppDatabaseService} from './appDatabaseService.ts'
import {getJsonValue, getSqlLiteral} from './appQueryHelpers.ts'

type ModelContextWindowRow = {
  displayName: string | null
  metadataJson: unknown
  providerConnectionId: string | null
  providerKind: string | null
  remoteModelId: string | null
}

type JudgmentJobModelContextWindowGateEntry = {checkedAt: number; error: ModelContextWindowMissingError | null}

export const judgmentJobModelContextWindowGateTtlMs = 30_000

const judgmentJobModelContextWindowGateEntries = new Map<string, JudgmentJobModelContextWindowGateEntry>()

export const getModelContextWindowErrorForRow = (row: ModelContextWindowRow): ModelContextWindowMissingError | null => {
  return getModelContextWindowMissingError({
    model: {
      metadataJson: getJsonValue(row.metadataJson),
      providerKind: row.providerKind,
      remoteModelId: row.remoteModelId,
    },
    modelName: row.displayName ?? row.remoteModelId ?? 'unknown model',
    providerConnectionId: row.providerConnectionId,
  })
}

export const getModelContextWindowErrorForModelId = async (
  modelId: string,
): Promise<ModelContextWindowMissingError | null> => {
  const [row] = await getAppDatabaseService().queryJson<ModelContextWindowRow>(`
    SELECT
      COALESCE(m.display_name, m.name) AS displayName,
      TO_JSON(m.metadata_json) AS metadataJson,
      m.provider_connection_id AS providerConnectionId,
      pc.provider_kind AS providerKind,
      m.remote_model_id AS remoteModelId
    FROM app.model m
    LEFT JOIN app.provider_connection pc ON pc.id = m.provider_connection_id
    WHERE m.id = ${getSqlLiteral(modelId)}
    LIMIT 1
  `)

  return row ? getModelContextWindowErrorForRow(row) : null
}

export const assertModelContextWindowResolvable = async (modelId: string): Promise<void> => {
  const error = await getModelContextWindowErrorForModelId(modelId)

  if (error) {
    throw new HttpError(409, error.message)
  }
}

const getJudgmentJobModelContextWindowErrorFromJobInfo = async (
  jobId: string,
): Promise<ModelContextWindowMissingError | null> => {
  const jobInfo = await getJudgmentJobSqliteService().getJobInfo(jobId)

  return jobInfo
    ? getModelContextWindowMissingError({
        model: {
          metadataJson: jobInfo.modelMetadataJson,
          providerKind: jobInfo.modelProvider,
          remoteModelId: jobInfo.modelName,
        },
        modelName: jobInfo.modelName,
        providerConnectionId: null,
      })
    : null
}

export const getJudgmentJobModelContextWindowClaimError = async (
  jobId: string,
  now: number = Date.now(),
): Promise<ModelContextWindowMissingError | null> => {
  const cached = judgmentJobModelContextWindowGateEntries.get(jobId)

  if (cached && now - cached.checkedAt < judgmentJobModelContextWindowGateTtlMs) {
    return cached.error
  }

  const error = await getJudgmentJobModelContextWindowErrorFromJobInfo(jobId)

  judgmentJobModelContextWindowGateEntries.set(jobId, {checkedAt: now, error})

  return error
}

export const resetJudgmentJobModelContextWindowGateForTests = (): void => {
  judgmentJobModelContextWindowGateEntries.clear()
}
