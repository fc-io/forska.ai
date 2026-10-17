import {Elysia, t} from 'elysia'

import {
  FULL_TEXT_STRATEGY_NONE,
  getEffectiveFullTextStrategyId,
  getFullTextStrategyDisplayLabel,
} from '../../fullText/fullTextStrategy.ts'
import {getFullTextStrategyLabelsById} from '../../fullText/fullTextStrategyRepository.ts'
import {getAppDatabaseService} from '../../services/appDatabaseService.ts'
import {getSqlLiteral} from '../../services/appQueryHelpers.ts'
import {
  fullTextChunkPolicyBodySchema,
  fullTextFigureModeBodySchema,
  getProjectFullTextResolution,
  getProjectVisibleJudgmentCount,
  type ProjectFullTextResolution,
} from './projectFullTextSettings.ts'

type CurrentProjectStrategyRow = {fullTextStrategyId: string | null}

const getPreviewStrategy = (useFulltext: boolean, resolution: ProjectFullTextResolution) => {
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

const getCurrentProjectStrategy = async (projectId: string) => {
  const database = getAppDatabaseService()
  const [row] = await database.queryJson<CurrentProjectStrategyRow>(`
    SELECT full_text_strategy_id AS fullTextStrategyId
    FROM app.project
    WHERE id = ${getSqlLiteral(projectId)}
    LIMIT 1
  `)
  const strategyId = row ? getEffectiveFullTextStrategyId(row.fullTextStrategyId) : null

  return strategyId
    ? {
        judgmentCount: await getProjectVisibleJudgmentCount(database, projectId),
        strategyId,
        strategyLabel: (await getFullTextStrategyLabelsById(database, [strategyId])).get(strategyId) ?? strategyId,
      }
    : null
}

export const projectsRoutesPostFullTextStrategyPreview = new Elysia().post(
  '/api/projects/full-text-strategy-preview',
  async ({body}) => {
    const resolution = await getProjectFullTextResolution({
      fullTextChunkPolicy: body.fullTextChunkPolicy ?? null,
      fullTextFigureMode: body.fullTextFigureMode ?? null,
      useFulltext: body.useFulltext,
    })

    return {
      data: {
        current: body.projectId ? await getCurrentProjectStrategy(body.projectId) : null,
        errors: resolution.errors,
        ...getPreviewStrategy(body.useFulltext, resolution),
      },
    }
  },
  {
    body: t.Object({
      fullTextChunkPolicy: t.Optional(t.Union([fullTextChunkPolicyBodySchema, t.Null()])),
      fullTextFigureMode: t.Optional(t.Union([fullTextFigureModeBodySchema, t.Null()])),
      projectId: t.Optional(t.String()),
      useFulltext: t.Boolean(),
    }),
  },
)
