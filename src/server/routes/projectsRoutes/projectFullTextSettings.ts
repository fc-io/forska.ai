import {t} from 'elysia'

import {
  FULL_TEXT_STRATEGY_NONE,
  type FullTextChunkPolicy,
  type FullTextFigureMode,
  type FullTextStrategy,
  getEffectiveFullTextStrategyId,
  getFullTextChunkPolicy,
  getFullTextStrategyDisplayLabel,
  isFullTextFigureMode,
} from '../../fullText/fullTextStrategy.ts'
import {upsertFullTextStrategy} from '../../fullText/fullTextStrategyRepository.ts'
import {getSqlLiteral} from '../../services/appQueryHelpers.ts'
import {getProjectFullTextGateForSelection} from '../../services/judgmentJobFullTextGate.ts'
import {getProjectVisibleJudgmentPromptSql} from '../../services/projectVisibleJudgmentRule.ts'
import {HttpError} from '../../utils/httpError.ts'

type ProjectFullTextQueryRunner = {queryJson: <T>(statement: string) => Promise<T[]>}

type ProjectFullTextWriteRunner = ProjectFullTextQueryRunner & {run: (statement: string) => Promise<unknown>}

export type ProjectFullTextRow = {
  fullTextChunkPolicy: unknown
  fullTextFigureMode: string | null
  fullTextStrategyId: string | null
  fullTextStrategyStoredLabel: string | null
}

export type ProjectFullTextSettings = {
  fullTextChunkPolicy: FullTextChunkPolicy | null
  fullTextFigureMode: FullTextFigureMode | null
  fullTextStrategyId: string | null
}

export type ProjectFullTextSelection = {
  fullTextChunkPolicy: FullTextChunkPolicy | null
  fullTextFigureMode: FullTextFigureMode | null
  useFulltext: boolean
}

export type ProjectFullTextResolution = ProjectFullTextSettings & {
  errors: string[]
  strategy: FullTextStrategy | null
  warnings: string[]
}

export const fullTextFigureModeBodySchema = t.Union([
  t.Literal('none'),
  t.Literal('descriptions'),
  t.Literal('native_images'),
])

export const fullTextChunkPolicyBodySchema = t.Object({
  maxPromptTokens: t.Union([t.Literal(24_000), t.Literal(48_000), t.Literal(96_000)]),
  mode: t.Union([t.Literal('single_only'), t.Literal('chunked')]),
})

export const fullTextStrategyRecordableJobStatuses: ReadonlySet<string> = new Set([
  'completed',
  'failed',
  'not_started',
  'paused',
])

export const fullTextStrategyRecordJobRunningErrorMessage =
  'Pause the judgment job before recording a new full-text strategy.'

export const fullTextStrategyRecordWithoutFullTextErrorMessage =
  'Only a project with explicit full-text settings can record a new full-text strategy.'

export const fullTextNoImagesReplacedErrorMessage =
  'useFulltextNoImages is replaced by fullTextFigureMode "none". Send useFulltext with a figure mode and a chunk policy.'

export const getProjectFullTextSelectSql = (projectAlias: string) => {
  return `
    ${projectAlias}.full_text_figure_mode AS fullTextFigureMode,
    TO_JSON(${projectAlias}.full_text_chunk_policy) AS fullTextChunkPolicy,
    ${projectAlias}.full_text_strategy_id AS fullTextStrategyId,
    (
      SELECT full_text_strategy.label
      FROM app.full_text_strategy full_text_strategy
      WHERE full_text_strategy.id = ${projectAlias}.full_text_strategy_id
    ) AS fullTextStrategyStoredLabel
  `
}

export const getProjectFullTextValues = <T extends ProjectFullTextRow>(row: T) => {
  const {fullTextStrategyStoredLabel, ...projectRow} = row

  return {
    ...projectRow,
    fullTextChunkPolicy: getFullTextChunkPolicy(row.fullTextChunkPolicy),
    fullTextFigureMode: isFullTextFigureMode(row.fullTextFigureMode) ? row.fullTextFigureMode : null,
    fullTextStrategyId: row.fullTextStrategyId,
    fullTextStrategyLabel: getFullTextStrategyDisplayLabel(
      getEffectiveFullTextStrategyId(row.fullTextStrategyId),
      fullTextStrategyStoredLabel,
    ),
  }
}

const getDisabledProjectFullTextResolution = (): ProjectFullTextResolution => {
  return {
    errors: [],
    fullTextChunkPolicy: null,
    fullTextFigureMode: null,
    fullTextStrategyId: null,
    strategy: null,
    warnings: [],
  }
}

const getEnabledProjectFullTextResolution = async (
  selection: ProjectFullTextSelection,
  modelId: string | null,
): Promise<ProjectFullTextResolution> => {
  const gate = await getProjectFullTextGateForSelection({modelId, selection})

  return {
    errors: gate.errors,
    fullTextChunkPolicy: selection.fullTextChunkPolicy,
    fullTextFigureMode: selection.fullTextFigureMode,
    fullTextStrategyId: gate.strategy?.id ?? null,
    strategy: gate.strategy,
    warnings: gate.warnings,
  }
}

export const getProjectFullTextResolution = async (
  selection: ProjectFullTextSelection,
  modelId: string | null,
): Promise<ProjectFullTextResolution> => {
  return selection.useFulltext
    ? getEnabledProjectFullTextResolution(selection, modelId)
    : getDisabledProjectFullTextResolution()
}

export const resolveProjectFullTextSettingsOrThrow = async (
  selection: ProjectFullTextSelection,
  modelId: string | null,
) => {
  const resolution = await getProjectFullTextResolution(selection, modelId)

  if (resolution.errors.length > 0) {
    throw new HttpError(400, resolution.errors.join(' '))
  }

  return resolution
}

export const saveProjectFullTextStrategy = async (
  runner: ProjectFullTextWriteRunner,
  resolution: ProjectFullTextResolution,
) => {
  return resolution.strategy ? upsertFullTextStrategy(runner, resolution.strategy) : undefined
}

export const getProjectFullTextColumnValuesSql = (settings: ProjectFullTextSettings) => {
  return {
    fullTextChunkPolicy: settings.fullTextChunkPolicy
      ? `${getSqlLiteral(JSON.stringify(settings.fullTextChunkPolicy))}::JSON`
      : 'NULL',
    fullTextFigureMode: getSqlLiteral(settings.fullTextFigureMode),
    fullTextStrategyId: getSqlLiteral(settings.fullTextStrategyId),
  }
}

export const getProjectFullTextUpdateParts = (settings: ProjectFullTextSettings) => {
  const values = getProjectFullTextColumnValuesSql(settings)

  return [
    `full_text_figure_mode = ${values.fullTextFigureMode}`,
    `full_text_chunk_policy = ${values.fullTextChunkPolicy}`,
    `full_text_strategy_id = ${values.fullTextStrategyId}`,
  ]
}

const isSameChunkPolicy = (left: FullTextChunkPolicy | null, right: FullTextChunkPolicy | null) => {
  return left?.maxPromptTokens === right?.maxPromptTokens && left?.mode === right?.mode
}

export const hasProjectFullTextSettingsChanged = (current: ProjectFullTextSettings, next: ProjectFullTextSettings) => {
  return (
    current.fullTextFigureMode !== next.fullTextFigureMode
    || !isSameChunkPolicy(current.fullTextChunkPolicy, next.fullTextChunkPolicy)
    || current.fullTextStrategyId !== next.fullTextStrategyId
  )
}

export const getProjectVisibleJudgmentCount = async (runner: ProjectFullTextQueryRunner, projectId: string) => {
  const [row] = await runner.queryJson<{judgmentCount: number | bigint | null}>(`
    SELECT COUNT(DISTINCT judgment.id) AS judgmentCount
    FROM app.project project
    INNER JOIN app.project_prompt project_prompt ON project_prompt.project_id = project.id
    INNER JOIN app.judgment judgment
      ON ${getProjectVisibleJudgmentPromptSql({
        judgmentAlias: 'judgment',
        projectAlias: 'project',
        projectPromptAlias: 'project_prompt',
      })}
    WHERE project.id = ${getSqlLiteral(projectId)}
      AND judgment.deleted_at IS NULL
  `)

  return Number(row?.judgmentCount ?? 0)
}

export const getFullTextStrategyIdOrNone = (resolution: ProjectFullTextResolution) => {
  return resolution.fullTextStrategyId ?? FULL_TEXT_STRATEGY_NONE
}
