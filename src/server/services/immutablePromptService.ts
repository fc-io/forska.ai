import type {PromptConfigReviewServingField} from '../reviewServing/reviewConfigReviewServingDeltaService.ts'
import {computePromptContentHash} from '../utils/computePromptContentHash.ts'
import {escapeSqlString, getSqlLiteral} from './appQueryHelpers.ts'

type PromptQueryRunner = {queryJson: <T>(statement: string) => Promise<T[]>; run: (statement: string) => Promise<void>}

type ImmutablePromptInput = {
  archived: boolean
  originalText: string
  promptHeading: string | null
  transformedText: string | null
  type: string | null
  unarchiveExisting?: boolean
}

type ImmutablePromptRow = {archived: boolean; id: string}

export const immutablePromptIdentityReviewServingFields = [
  'promptText',
  'promptHeading',
  'promptType',
] as const satisfies readonly PromptConfigReviewServingField[]

const getImmutablePromptByContentHash = async (
  queryRunner: PromptQueryRunner,
  contentHash: string,
): Promise<ImmutablePromptRow | null> => {
  const [existingPrompt] = await queryRunner.queryJson<ImmutablePromptRow>(`
    SELECT id, archived
    FROM app.prompt
    WHERE content_hash = ${getSqlLiteral(contentHash)}
    LIMIT 1
  `)

  return existingPrompt ?? null
}

export const getOrCreateImmutablePromptTx = async (queryRunner: PromptQueryRunner, params: ImmutablePromptInput) => {
  const contentHash = computePromptContentHash(
    params.originalText,
    params.transformedText,
    params.promptHeading,
    params.type,
  )
  const [insertedPrompt] = await queryRunner.queryJson<ImmutablePromptRow>(`
    INSERT INTO app.prompt (id, original_text, transformed_text, prompt_heading, type, content_hash, archived)
    VALUES (
      '${escapeSqlString(crypto.randomUUID())}',
      ${getSqlLiteral(params.originalText)},
      ${getSqlLiteral(params.transformedText)},
      ${getSqlLiteral(params.promptHeading)},
      ${getSqlLiteral(params.type)},
      ${getSqlLiteral(contentHash)},
      ${params.archived ? 'TRUE' : 'FALSE'}
    )
    ON CONFLICT(content_hash) DO NOTHING
    RETURNING id, archived
  `)
  const prompt = insertedPrompt ?? (await getImmutablePromptByContentHash(queryRunner, contentHash))

  if (!prompt) {
    return null
  }

  if (!params.archived && prompt.archived && params.unarchiveExisting !== false) {
    const [unarchivedPrompt] = await queryRunner.queryJson<{id: string}>(`
      UPDATE app.prompt
      SET archived = FALSE,
          updated_at = current_timestamp
      WHERE id = ${getSqlLiteral(prompt.id)}
        AND archived = TRUE
      RETURNING id
    `)

    return unarchivedPrompt?.id ?? prompt.id
  }

  return prompt.id
}

export const getImmutablePromptIdByContentHash = async (queryRunner: PromptQueryRunner, contentHash: string) => {
  const existingPrompt = await getImmutablePromptByContentHash(queryRunner, contentHash)

  return existingPrompt?.id ?? null
}
