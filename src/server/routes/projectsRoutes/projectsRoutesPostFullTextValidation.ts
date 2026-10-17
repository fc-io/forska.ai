import {Elysia, t} from 'elysia'

import {
  FULL_TEXT_STRATEGY_NONE,
  type FullTextStrategy,
  getFullTextStrategyDisplayLabel,
} from '../../fullText/fullTextStrategy.ts'
import {getAppDatabaseService} from '../../services/appDatabaseService.ts'
import {getSqlLiteral} from '../../services/appQueryHelpers.ts'
import {
  fullTextStrategyChangedRemedies,
  getFullTextStrategyChangedSinceSaveMessage,
  getStoredStrategyFromRow,
  type ProjectFullTextGateProjectRow,
  type ProjectFullTextGateStoredStrategy,
} from '../../services/judgmentJobFullTextGate.ts'
import {
  fullTextChunkPolicyBodySchema,
  fullTextFigureModeBodySchema,
  fullTextStrategyRecordableJobStatuses,
  getProjectFullTextResolution,
  getProjectVisibleJudgmentCount,
  type ProjectFullTextResolution,
} from './projectFullTextSettings.ts'

type CurrentProjectStrategyRow = Pick<
  ProjectFullTextGateProjectRow,
  'fullTextStrategyId' | 'fullTextStrategyInputs' | 'fullTextStrategyStoredLabel'
> & {jobStatus: string | null}

type CurrentProjectStrategy = {
  jobStatus: string | null
  judgmentCount: number
  storedStrategy: ProjectFullTextGateStoredStrategy
}

const noStrategyChangeWithJob = {recordStrategyOnSave: false, warnings: [] as string[]}

const getValidationStrategy = (useFulltext: boolean, resolution: ProjectFullTextResolution) => {
  return useFulltext
    ? {
        strategyId: resolution.strategy?.id ?? null,
        strategyInputs: resolution.strategy?.inputs ?? null,
        strategyLabel: resolution.strategy?.label ?? null,
      }
    : {
        strategyId: FULL_TEXT_STRATEGY_NONE,
        strategyInputs: null,
        strategyLabel: getFullTextStrategyDisplayLabel(FULL_TEXT_STRATEGY_NONE, null),
      }
}

const getCurrentProjectStrategy = async (projectId: string): Promise<CurrentProjectStrategy | null> => {
  const database = getAppDatabaseService()
  const [row] = await database.queryJson<CurrentProjectStrategyRow>(`
    SELECT
      p.full_text_strategy_id AS fullTextStrategyId,
      full_text_strategy.label AS fullTextStrategyStoredLabel,
      TO_JSON(full_text_strategy.inputs) AS fullTextStrategyInputs,
      (
        SELECT jj.status
        FROM app.judgment_job jj
        WHERE jj.project_id = p.id
        LIMIT 1
      ) AS jobStatus
    FROM app.project p
    LEFT JOIN app.full_text_strategy full_text_strategy ON full_text_strategy.id = p.full_text_strategy_id
    WHERE p.id = ${getSqlLiteral(projectId)}
    LIMIT 1
  `)

  return row
    ? {
        jobStatus: row.jobStatus,
        judgmentCount: await getProjectVisibleJudgmentCount(database, projectId),
        storedStrategy: getStoredStrategyFromRow(row),
      }
    : null
}

const isJobStoppedForStrategyRecord = (current: CurrentProjectStrategy) => {
  return fullTextStrategyRecordableJobStatuses.has(current.jobStatus ?? '')
}

const getStrategyChangeWithJobWarning = (current: CurrentProjectStrategy, strategy: FullTextStrategy) => {
  return getFullTextStrategyChangedSinceSaveMessage({
    remedy: isJobStoppedForStrategyRecord(current)
      ? fullTextStrategyChangedRemedies.editPageJobStopped
      : fullTextStrategyChangedRemedies.editPageJobRunning,
    storedStrategy: current.storedStrategy,
    strategy,
  })
}

const getStrategyChangeWithJob = (current: CurrentProjectStrategy | null, resolution: ProjectFullTextResolution) => {
  const strategy = resolution.strategy

  return current?.jobStatus && strategy && resolution.errors.length === 0 && strategy.id !== current.storedStrategy.id
    ? {
        recordStrategyOnSave: isJobStoppedForStrategyRecord(current),
        warnings: [getStrategyChangeWithJobWarning(current, strategy)],
      }
    : noStrategyChangeWithJob
}

const getCurrentProjectStrategyPayload = (current: CurrentProjectStrategy | null) => {
  return current
    ? {
        judgmentCount: current.judgmentCount,
        strategyId: current.storedStrategy.id,
        strategyLabel: current.storedStrategy.label,
      }
    : null
}

export const projectsRoutesPostFullTextValidation = new Elysia().post(
  '/api/projects/full-text-validation',
  async ({body}) => {
    const resolution = await getProjectFullTextResolution(
      {
        fullTextChunkPolicy: body.fullTextChunkPolicy ?? null,
        fullTextFigureMode: body.fullTextFigureMode ?? null,
        useFulltext: body.useFulltext,
      },
      body.modelId ?? null,
    )
    const current = body.projectId ? await getCurrentProjectStrategy(body.projectId) : null
    const strategyChangeWithJob = getStrategyChangeWithJob(current, resolution)

    return {
      data: {
        current: getCurrentProjectStrategyPayload(current),
        errors: resolution.errors,
        recordStrategyOnSave: strategyChangeWithJob.recordStrategyOnSave,
        warnings: [...resolution.warnings, ...strategyChangeWithJob.warnings],
        ...getValidationStrategy(body.useFulltext, resolution),
      },
    }
  },
  {
    body: t.Object({
      fullTextChunkPolicy: t.Optional(t.Union([fullTextChunkPolicyBodySchema, t.Null()])),
      fullTextFigureMode: t.Optional(t.Union([fullTextFigureModeBodySchema, t.Null()])),
      modelId: t.Optional(t.Union([t.String(), t.Null()])),
      projectId: t.Optional(t.String()),
      useFulltext: t.Boolean(),
    }),
  },
)
