import {Elysia, t} from 'elysia'

import {
  FULL_TEXT_STRATEGY_NONE,
  type FullTextStrategy,
  getFullTextStrategyDisplayLabel,
} from '../../fullText/fullTextStrategy.ts'
import {getModelImageInputForModelId} from '../../fullText/nativeImagesModelCheck.ts'
import {
  fullTextStrategyChangedRemedies,
  getFullTextStrategyChangedSinceSaveMessage,
} from '../../services/judgmentJobFullTextGate.ts'
import {
  getProjectFullTextCurrentStrategy,
  getProjectFullTextValidationReader,
  type ProjectFullTextCurrentStrategy,
} from '../../services/projectFullTextCurrentStrategy.ts'
import {
  fullTextChunkPolicyBodySchema,
  fullTextFigureModeBodySchema,
  fullTextStrategyRecordableJobStatuses,
  getProjectFullTextResolution,
  type ProjectFullTextResolution,
} from './projectFullTextSettings.ts'

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

const isJobStoppedForStrategyRecord = (current: ProjectFullTextCurrentStrategy) => {
  return fullTextStrategyRecordableJobStatuses.has(current.jobStatus ?? '')
}

const getStrategyChangeWithJobWarning = (current: ProjectFullTextCurrentStrategy, strategy: FullTextStrategy) => {
  return getFullTextStrategyChangedSinceSaveMessage({
    remedy: isJobStoppedForStrategyRecord(current)
      ? fullTextStrategyChangedRemedies.editPageJobStopped
      : fullTextStrategyChangedRemedies.editPageJobRunning,
    storedStrategy: current.storedStrategy,
    strategy,
  })
}

const getStrategyChangeWithJob = (
  current: ProjectFullTextCurrentStrategy | null,
  resolution: ProjectFullTextResolution,
) => {
  const strategy = resolution.strategy

  return current?.jobStatus && strategy && resolution.errors.length === 0 && strategy.id !== current.storedStrategy.id
    ? {
        recordStrategyOnSave: isJobStoppedForStrategyRecord(current),
        warnings: [getStrategyChangeWithJobWarning(current, strategy)],
      }
    : noStrategyChangeWithJob
}

const getCurrentProjectStrategyPayload = (current: ProjectFullTextCurrentStrategy | null) => {
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
    const reader = getProjectFullTextValidationReader()
    const resolution = await getProjectFullTextResolution(
      {
        fullTextChunkPolicy: body.fullTextChunkPolicy ?? null,
        fullTextFigureMode: body.fullTextFigureMode ?? null,
        useFulltext: body.useFulltext,
      },
      body.modelId ?? null,
      reader,
    )
    const current = body.projectId ? await getProjectFullTextCurrentStrategy(body.projectId, reader) : null
    const strategyChangeWithJob = getStrategyChangeWithJob(current, resolution)
    const modelImageInput = body.modelId
      ? await getModelImageInputForModelId({modelId: body.modelId, runner: reader})
      : null

    return {
      data: {
        current: getCurrentProjectStrategyPayload(current),
        errors: resolution.errors,
        modelAcceptsImages: modelImageInput?.acceptsImages ?? false,
        modelLabel: modelImageInput?.label ?? null,
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
