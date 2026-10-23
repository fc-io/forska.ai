import type {ProjectPromptCriteriaDisposition} from '../../../db/schemaTypes.ts'
import {
  appendPromptConfigReviewServingDelta,
  type PromptConfigReviewServingField,
} from '../../reviewServing/reviewConfigReviewServingDeltaService.ts'
import {escapeSqlString, getSqlLiteral} from '../../services/appQueryHelpers.ts'
import type {AppTx} from './appTx.ts'

export const upsertProjectPromptTx = async (
  tx: AppTx,
  params: {
    changedPromptConfigFields?: PromptConfigReviewServingField[]
    projectId: string
    promptId: string
    order: number
    archived: boolean
    enabled: boolean
    originProjectId: string | null
    criteriaDisposition: ProjectPromptCriteriaDisposition | null
    criteriaSectionKey: string | null
    criteriaSectionLabel: string | null
  },
) => {
  const sourceUpdatedAt = new Date().toISOString()
  const hasCriteriaMetadata =
    params.criteriaDisposition !== null || params.criteriaSectionKey !== null || params.criteriaSectionLabel !== null
  const criteriaUpdateParts = hasCriteriaMetadata
    ? [
        'criteria_disposition = EXCLUDED.criteria_disposition',
        'criteria_section_key = EXCLUDED.criteria_section_key',
        'criteria_section_label = EXCLUDED.criteria_section_label',
      ]
    : []
  const updateParts = [
    'prompt_order = EXCLUDED.prompt_order',
    'archived = EXCLUDED.archived',
    'enabled = EXCLUDED.enabled',
    ...criteriaUpdateParts,
    'updated_at = EXCLUDED.updated_at',
  ]

  // DuckDB 1.5.1 can abort at COMMIT when this conflict update is consumed through DML RETURNING.
  await tx.run(`
    INSERT INTO app.project_prompt (
      id,
      project_id,
      prompt_id,
      prompt_order,
      archived,
      enabled,
      origin_project_id,
      criteria_disposition,
      criteria_section_key,
      criteria_section_label,
      updated_at
    )
    VALUES (
      '${escapeSqlString(crypto.randomUUID())}',
      '${escapeSqlString(params.projectId)}',
      '${escapeSqlString(params.promptId)}',
      ${params.order},
      ${params.archived ? 'TRUE' : 'FALSE'},
      ${params.enabled ? 'TRUE' : 'FALSE'},
      ${getSqlLiteral(params.originProjectId)},
      ${getSqlLiteral(params.criteriaDisposition)},
      ${getSqlLiteral(params.criteriaSectionKey)},
      ${getSqlLiteral(params.criteriaSectionLabel)},
      ${getSqlLiteral(sourceUpdatedAt)}::TIMESTAMPTZ
    )
    ON CONFLICT(project_id, prompt_id) DO UPDATE SET
      ${updateParts.join(',\n      ')}
  `)

  await appendPromptConfigReviewServingDelta(tx, {
    changedPromptConfigFields: params.changedPromptConfigFields ?? ['archived', 'enabled', 'promptOrder'],
    projectId: params.projectId,
    promptId: params.promptId,
    sourceMutationKey: `projectPromptUpsert|${params.projectId}|${params.promptId}|${sourceUpdatedAt}`,
    sourceOperation: 'upsert',
    sourceUpdatedAt,
  })
}
