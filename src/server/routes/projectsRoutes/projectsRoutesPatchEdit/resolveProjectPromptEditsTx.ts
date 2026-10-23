import {escapeSqlString} from '../../../services/appQueryHelpers.ts'
import {
  getOrCreateImmutablePromptTx,
  immutablePromptIdentityReviewServingFields,
} from '../../../services/immutablePromptService.ts'
import {HttpError} from '../../../utils/httpError.ts'
import type {AppTx} from '../appTx.ts'
import type {projectsRoutesPatchEditBody} from '../projectsRoutesPatchEditBody.ts'
import {getPromptMetadataValue} from './getPromptMetadataValue.ts'
import type {
  ExistingProjectPromptAssociation,
  ProjectEditPromptPayload,
  ResolvedProjectPromptEdit,
} from './projectEditTypes.ts'

export const resolveProjectPromptEditsTx = async (
  tx: AppTx,
  {
    existing,
    existingPromptIds,
    submitted,
  }: {
    existing: ExistingProjectPromptAssociation[]
    existingPromptIds: Set<string>
    submitted: NonNullable<(typeof projectsRoutesPatchEditBody.static)['prompts']>
  },
) => {
  const resolvedPromptEdits: ResolvedProjectPromptEdit[] = []

  for (const prompt of submitted as ProjectEditPromptPayload[]) {
    const order = prompt.order
    const archived = typeof prompt.archived === 'boolean' ? prompt.archived : undefined
    const enabled = typeof prompt.enabled === 'boolean' ? prompt.enabled : undefined

    if (prompt.originalId) {
      const isAlreadyAssociated = existingPromptIds.has(prompt.originalId)
      if (!isAlreadyAssociated && enabled !== true) {
        continue
      }

      const [existingPrompt] = await tx.queryJson<{
        id: string
        originalText: string
        promptHeading: string | null
        type: string | null
        promptArchived: boolean
      }>(`
                SELECT
                  id,
                  original_text AS originalText,
                  prompt_heading AS promptHeading,
                  type,
                  archived AS promptArchived
                FROM app.prompt
                WHERE id = '${escapeSqlString(prompt.originalId)}'
                LIMIT 1
              `)

      if (!existingPrompt) {
        throw new HttpError(400, `Prompt not found: ${prompt.originalId}`)
      }

      const existingPromptHeading = getPromptMetadataValue(existingPrompt.promptHeading) ?? null
      const existingPromptType = getPromptMetadataValue(existingPrompt.type) ?? null
      const promptHeading = getPromptMetadataValue(prompt.promptHeading)
      const promptType = getPromptMetadataValue(prompt.type)
      const targetPromptHeading = promptHeading === undefined ? existingPromptHeading : promptHeading
      const targetPromptType = promptType === undefined ? existingPromptType : promptType
      const textChanged = existingPrompt.originalText !== prompt.originalText
      const metaChanged = targetPromptHeading !== existingPromptHeading || targetPromptType !== existingPromptType

      const targetPromptId =
        textChanged || metaChanged
          ? await getOrCreateImmutablePromptTx(tx, {
              originalText: prompt.originalText,
              transformedText: null,
              promptHeading: targetPromptHeading,
              type: targetPromptType,
              archived: existingPrompt.promptArchived,
              unarchiveExisting: false,
            })
          : prompt.originalId

      if (!targetPromptId) {
        throw new Error('Prompt not found after insert')
      }

      const currentAssociation = existing.find((entry) => {
        return entry.promptId === prompt.originalId
      })
      const shouldIncludePromptIdentity = !currentAssociation || targetPromptId !== prompt.originalId

      resolvedPromptEdits.push({
        archived,
        changedPromptConfigFields: [
          ...(shouldIncludePromptIdentity
            ? immutablePromptIdentityReviewServingFields
            : [
                ...(textChanged ? (['promptText'] as const) : []),
                ...(targetPromptHeading !== existingPromptHeading ? (['promptHeading'] as const) : []),
                ...(targetPromptType !== existingPromptType ? (['promptType'] as const) : []),
              ]),
          ...(prompt.order !== currentAssociation?.order ? (['promptOrder'] as const) : []),
          ...(typeof archived === 'boolean' && archived !== currentAssociation?.archived
            ? (['archived'] as const)
            : []),
          ...(typeof enabled === 'boolean' && enabled !== currentAssociation?.enabled ? (['enabled'] as const) : []),
        ],
        currentAssociation,
        enabled,
        order,
        originalId: prompt.originalId,
        shouldDeleteOriginalAssociation: textChanged || metaChanged,
        targetPromptId,
      })
    } else {
      const targetPromptId = await getOrCreateImmutablePromptTx(tx, {
        originalText: prompt.originalText,
        transformedText: null,
        promptHeading: getPromptMetadataValue(prompt.promptHeading) ?? null,
        type: getPromptMetadataValue(prompt.type) ?? null,
        archived: false,
        unarchiveExisting: false,
      })

      if (!targetPromptId) {
        throw new Error('Prompt not found after insert')
      }

      resolvedPromptEdits.push({
        archived,
        changedPromptConfigFields: [...immutablePromptIdentityReviewServingFields, 'promptOrder', 'enabled'],
        currentAssociation: undefined,
        enabled,
        order,
        originalId: undefined,
        shouldDeleteOriginalAssociation: false,
        targetPromptId,
      })
    }
  }

  return resolvedPromptEdits
}
