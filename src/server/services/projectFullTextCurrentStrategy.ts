import {getAppDatabaseService} from './appDatabaseService.ts'
import {getSqlLiteral} from './appQueryHelpers.ts'
import {
  getStoredStrategyFromRow,
  type ProjectFullTextGateProjectRow,
  type ProjectFullTextGateStoredStrategy,
} from './judgmentJobFullTextGate.ts'
import {getProjectVisibleJudgmentPromptSql} from './projectVisibleJudgmentRule.ts'

type CurrentStrategyRunner = {queryJson: <T>(statement: string) => Promise<T[]>}

type CurrentProjectStrategyRow = Pick<
  ProjectFullTextGateProjectRow,
  'fullTextStrategyId' | 'fullTextStrategyInputs' | 'fullTextStrategyStoredLabel'
> & {jobStatus: string | null}

export type ProjectFullTextCurrentStrategy = {
  jobStatus: string | null
  judgmentCount: number
  storedStrategy: ProjectFullTextGateStoredStrategy
}

export const getProjectVisibleJudgmentCount = async (runner: CurrentStrategyRunner, projectId: string) => {
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

export const getProjectFullTextCurrentStrategy = async (
  projectId: string,
  runner: CurrentStrategyRunner = getAppDatabaseService(),
): Promise<ProjectFullTextCurrentStrategy | null> => {
  const [row] = await runner.queryJson<CurrentProjectStrategyRow>(`
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
        judgmentCount: await getProjectVisibleJudgmentCount(runner, projectId),
        storedStrategy: getStoredStrategyFromRow(row),
      }
    : null
}
