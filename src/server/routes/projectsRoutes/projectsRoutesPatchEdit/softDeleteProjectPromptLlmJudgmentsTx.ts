import {appendLlmJudgmentReviewServingDeltas} from '../../../reviewServing/llmJudgmentReviewServingDeltaService.ts'
import {getQuotedStringList} from '../../../services/appQueryHelpers.ts'
import type {AppTx} from '../appTx.ts'
import {getProjectPromptLlmCleanupCandidateRowsTx} from './getProjectPromptLlmCleanupCandidateRowsTx.ts'
import {getUniqueSortedStrings} from './getUniqueSortedStrings.ts'
import type {ChangedProjectPromptLink, ProjectPromptLlmCleanupSummary} from './projectEditTypes.ts'

const getProjectPromptLlmCleanupEmptySummary = (): ProjectPromptLlmCleanupSummary => {
  return {keptSharedLlmJudgments: 0, skippedComparisonPromptReferencedJudgments: 0, softDeletedLlmJudgments: 0}
}

export const softDeleteProjectPromptLlmJudgmentsTx = async (
  tx: AppTx,
  params: {changedPromptLinks: ChangedProjectPromptLink[]; projectId: string},
) => {
  const oldPromptIds = getUniqueSortedStrings(
    params.changedPromptLinks.map((link) => {
      return link.oldPromptId
    }),
  )

  if (oldPromptIds.length === 0) {
    return getProjectPromptLlmCleanupEmptySummary()
  }

  const candidateRows = await getProjectPromptLlmCleanupCandidateRowsTx(tx, {oldPromptIds, projectId: params.projectId})
  const softDeleteIds = candidateRows
    .filter((row) => {
      return !row.comparisonPromptReferenced && !row.sharedProjectReferenced
    })
    .map((row) => {
      return row.id
    })

  if (softDeleteIds.length > 0) {
    await appendLlmJudgmentReviewServingDeltas(
      tx,
      candidateRows
        .filter((row) => {
          return softDeleteIds.includes(row.id)
        })
        .map((row) => {
          return {
            articleId: row.articleId,
            changeKind: 'judgment.llm.deleted' as const,
            judgmentId: row.id,
            modelId: row.modelId,
            projectId: params.projectId,
            promptId: row.promptId,
            sourceMutationKey: `projectPromptCleanup|${params.projectId}|${row.id}`,
            sourceOperation: 'delete' as const,
            sourceUpdatedAt: row.updatedAt,
            systemPromptVariant: row.systemPromptVariant,
            fullTextStrategyId: row.fullTextStrategyId,
            useAbstract: row.useAbstract,
            useFulltext: row.useFulltext,
            useFulltextNoImages: row.useFulltextNoImages,
            useMetadata: row.useMetadata,
            useTitle: row.useTitle,
          }
        }),
    )
    await tx.run(`
      UPDATE app.judgment AS judgment
      SET deleted_at = current_timestamp,
          updated_at = current_timestamp,
          delete_generation = (
            SELECT COALESCE(MAX(existing.delete_generation), judgment.delete_generation) + 1
            FROM app.judgment existing
            WHERE existing.article_id = judgment.article_id
              AND existing.prompt_id = judgment.prompt_id
              AND existing.model_id = judgment.model_id
              AND existing.use_title = judgment.use_title
              AND existing.use_abstract = judgment.use_abstract
              AND existing.use_fulltext = judgment.use_fulltext
              AND existing.use_fulltext_no_images = judgment.use_fulltext_no_images
              AND existing.use_metadata = judgment.use_metadata
              AND existing.system_prompt_variant = judgment.system_prompt_variant
              AND existing.full_text_strategy_id = judgment.full_text_strategy_id
          )
      WHERE judgment.id IN (${getQuotedStringList(softDeleteIds).join(', ')})
    `)
  }

  return {
    keptSharedLlmJudgments: candidateRows.filter((row) => {
      return row.sharedProjectReferenced
    }).length,
    skippedComparisonPromptReferencedJudgments: candidateRows.filter((row) => {
      return row.comparisonPromptReferenced
    }).length,
    softDeletedLlmJudgments: softDeleteIds.length,
  }
}
