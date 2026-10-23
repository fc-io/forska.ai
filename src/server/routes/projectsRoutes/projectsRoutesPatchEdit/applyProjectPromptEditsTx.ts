import {escapeSqlString, getQuotedStringList} from '../../../services/appQueryHelpers.ts'
import {HttpError} from '../../../utils/httpError.ts'
import type {AppTx} from '../appTx.ts'
import type {projectsRoutesPatchEditBody} from '../projectsRoutesPatchEditBody.ts'
import {upsertProjectPromptTx} from '../upsertProjectPromptTx.ts'
import {deleteProjectHumanPromptAnswersForChangedPromptLinksTx} from './deleteProjectHumanPromptAnswersForChangedPromptLinksTx.ts'
import {getChangedProjectPromptLinks} from './getChangedProjectPromptLinks.ts'
import {getDuplicateTargetPromptIds} from './getDuplicateTargetPromptIds.ts'
import {getUniqueSortedStrings} from './getUniqueSortedStrings.ts'
import {logProjectPromptCleanupSummary} from './logProjectPromptCleanupSummary.ts'
import type {ExistingProjectPromptAssociation, ProjectPromptCleanupSummary} from './projectEditTypes.ts'
import {resolveProjectPromptEditsTx} from './resolveProjectPromptEditsTx.ts'
import {softDeleteProjectPromptLlmJudgmentsTx} from './softDeleteProjectPromptLlmJudgmentsTx.ts'

export const applyProjectPromptEditsTx = async (
  tx: AppTx,
  {
    body,
    params,
  }: {body: {prompts: NonNullable<(typeof projectsRoutesPatchEditBody.static)['prompts']>}; params: {id: string}},
) => {
  const submitted = body.prompts.filter((prompt) => {
    return (prompt.originalText ?? '').trim() !== ''
  })
  const existing = await tx.queryJson<ExistingProjectPromptAssociation>(`
            SELECT
              id,
              prompt_id AS promptId,
              origin_project_id AS originProjectId,
              archived,
              enabled,
              criteria_disposition AS criteriaDisposition,
              criteria_section_key AS criteriaSectionKey,
              criteria_section_label AS criteriaSectionLabel,
              prompt_order AS "order"
            FROM app.project_prompt
            WHERE project_id = '${escapeSqlString(params.id)}'
          `)

  const existingPromptIds = new Set(
    existing.map((prompt) => {
      return prompt.promptId
    }),
  )
  const resolvedPromptEdits = await resolveProjectPromptEditsTx(tx, {existing, existingPromptIds, submitted})

  const duplicateTargetPromptIds = getDuplicateTargetPromptIds(
    resolvedPromptEdits.map((promptEdit) => {
      return promptEdit.targetPromptId
    }),
  )

  if (duplicateTargetPromptIds.length > 0) {
    throw new HttpError(
      400,
      'Project prompts must resolve to unique prompt content. Remove duplicate prompt text, heading, and type before saving.',
    )
  }

  const receivedOriginalIds = new Set(
    resolvedPromptEdits
      .map((promptEdit) => {
        return promptEdit.originalId
      })
      .filter((id): id is string => {
        return typeof id === 'string'
      }),
  )
  const finalTargetPromptIds = new Set(
    resolvedPromptEdits.map((promptEdit) => {
      return promptEdit.targetPromptId
    }),
  )
  const toDeleteAssoc = existing.filter((entry) => {
    return !receivedOriginalIds.has(entry.promptId) && !finalTargetPromptIds.has(entry.promptId)
  })
  const originalPromptIdsToDelete = getUniqueSortedStrings(
    resolvedPromptEdits
      .filter((promptEdit) => {
        return (
          promptEdit.shouldDeleteOriginalAssociation
          && typeof promptEdit.originalId === 'string'
          && !finalTargetPromptIds.has(promptEdit.originalId)
        )
      })
      .map((promptEdit) => {
        return promptEdit.originalId
      })
      .filter((id): id is string => {
        return typeof id === 'string'
      }),
  )
  const promptIdsToDelete = getUniqueSortedStrings([
    ...toDeleteAssoc.map((entry) => {
      return entry.promptId
    }),
    ...originalPromptIdsToDelete,
  ])
  const changedPromptLinks = getChangedProjectPromptLinks({removedAssociations: toDeleteAssoc, resolvedPromptEdits})

  if (promptIdsToDelete.length > 0) {
    await tx.run(`
              DELETE FROM app.project_prompt
              WHERE project_id = '${escapeSqlString(params.id)}'
                AND prompt_id IN (${getQuotedStringList(promptIdsToDelete).join(', ')})
            `)
  }

  for (const promptEdit of resolvedPromptEdits) {
    if (promptEdit.currentAssociation) {
      if (promptEdit.changedPromptConfigFields.length === 0) {
        continue
      }

      await upsertProjectPromptTx(tx, {
        changedPromptConfigFields: promptEdit.changedPromptConfigFields,
        projectId: params.id,
        promptId: promptEdit.targetPromptId,
        order: promptEdit.order,
        archived: promptEdit.archived ?? promptEdit.currentAssociation.archived,
        enabled: promptEdit.enabled ?? promptEdit.currentAssociation.enabled,
        originProjectId: null,
        criteriaDisposition: promptEdit.currentAssociation.criteriaDisposition,
        criteriaSectionKey: promptEdit.currentAssociation.criteriaSectionKey,
        criteriaSectionLabel: promptEdit.currentAssociation.criteriaSectionLabel,
      })
    } else {
      await upsertProjectPromptTx(tx, {
        changedPromptConfigFields: promptEdit.changedPromptConfigFields,
        projectId: params.id,
        promptId: promptEdit.targetPromptId,
        order: promptEdit.order,
        archived: promptEdit.archived ?? false,
        enabled: promptEdit.enabled ?? true,
        originProjectId: null,
        criteriaDisposition: null,
        criteriaSectionKey: null,
        criteriaSectionLabel: null,
      })
    }
  }

  const promptCleanupSummary: ProjectPromptCleanupSummary = {
    changedPromptLinks,
    deletedHumanPromptAnswers: await deleteProjectHumanPromptAnswersForChangedPromptLinksTx(tx, {
      changedPromptLinks,
      projectId: params.id,
    }),
    ...(await softDeleteProjectPromptLlmJudgmentsTx(tx, {changedPromptLinks, projectId: params.id})),
  }
  logProjectPromptCleanupSummary({projectId: params.id, summary: promptCleanupSummary})

  return promptCleanupSummary
}
