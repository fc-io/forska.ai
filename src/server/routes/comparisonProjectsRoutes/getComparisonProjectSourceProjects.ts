import {getSystemPromptVariant} from '../../../agent/judge/systemPromptVariant.ts'
import type {HumanJudgmentMode} from '../../../db/schemaTypes.ts'
import {getEffectiveFullTextStrategyId, getProjectFullTextStrategyIdSql} from '../../fullText/fullTextStrategy.ts'
import {modelTable, projectTable} from './comparisonProjectRouteConstants.ts'
import {appDatabaseService} from './comparisonProjectRouteServices.ts'
import type {AppQueryRunner} from './comparisonProjectRouteTypes.ts'
import type {ComparisonProjectLinkedSourceProject} from './comparisonProjectScopeTypes.ts'
import {getInClause} from './comparisonProjectSqlClauses.ts'

export const getComparisonProjectSourceProjects = async (
  sourceProjectIds: string[],
  queryRunner: AppQueryRunner = appDatabaseService,
) => {
  if (sourceProjectIds.length === 0) {
    return []
  }

  const sourceProjectRows = await queryRunner.queryJson<
    Omit<
      ComparisonProjectLinkedSourceProject,
      'fullTextStrategyId' | 'humanJudgmentMode' | 'systemPromptVariant' | 'useMetadata'
    > & {
      fullTextStrategyId?: string | null
      humanJudgmentMode: HumanJudgmentMode | null
      systemPromptVariant?: string | null
      useMetadata?: boolean | null
    }
  >(`
    SELECT
      p.id AS id,
      p.name AS name,
      p.description AS description,
      p.model_id AS modelId,
      COALESCE(m.display_name, m.name, m.remote_model_id, p.model_id) AS modelName,
      p.human_judgment_mode AS humanJudgmentMode,
      p.system_prompt_variant AS systemPromptVariant,
      COALESCE(p.use_metadata, FALSE) AS useMetadata,
      ${getProjectFullTextStrategyIdSql('p')} AS fullTextStrategyId
    FROM ${projectTable} p
    LEFT JOIN ${modelTable} m ON m.id = p.model_id
    WHERE p.id IN (${getInClause(sourceProjectIds)})
    ORDER BY p.name ASC
  `)
  const sourceProjectOrderLookup = sourceProjectIds.reduce<Record<string, number>>(
    (orderLookup, sourceProjectId, index) => {
      return {...orderLookup, [sourceProjectId]: index}
    },
    {},
  )

  return sourceProjectRows
    .map<ComparisonProjectLinkedSourceProject>((sourceProjectRow) => {
      return {
        ...sourceProjectRow,
        humanJudgmentMode: sourceProjectRow.humanJudgmentMode ?? 'prompt',
        systemPromptVariant: getSystemPromptVariant(sourceProjectRow.systemPromptVariant),
        useMetadata: sourceProjectRow.useMetadata === true,
        fullTextStrategyId: getEffectiveFullTextStrategyId(sourceProjectRow.fullTextStrategyId),
      }
    })
    .sort((left, right) => {
      return (
        (sourceProjectOrderLookup[left.id] ?? Number.MAX_SAFE_INTEGER)
        - (sourceProjectOrderLookup[right.id] ?? Number.MAX_SAFE_INTEGER)
      )
    })
}
