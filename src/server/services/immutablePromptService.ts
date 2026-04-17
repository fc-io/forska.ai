import {computePromptContentHash} from '../utils/computePromptContentHash.ts'
import {escapeSqlString, getSqlLiteral} from './appQueryHelpers.ts'

type PromptQueryRunner = {queryJson: <T>(statement: string) => Promise<T[]>}

type ImmutablePromptInput = {
  archived: boolean
  originalText: string
  promptHeading: string | null
  transformedText: string | null
  type: string | null
}

export const getOrCreateImmutablePromptTx = async (queryRunner: PromptQueryRunner, params: ImmutablePromptInput) => {
  const contentHash = computePromptContentHash(
    params.originalText,
    params.transformedText,
    params.promptHeading,
    params.type,
  )
  const [existingPrompt] = await queryRunner.queryJson<{id: string}>(`
    SELECT id
    FROM app.prompt
    WHERE content_hash = ${getSqlLiteral(contentHash)}
      AND archived = ${params.archived ? 'TRUE' : 'FALSE'}
    LIMIT 1
  `)

  if (existingPrompt) {
    return existingPrompt.id
  }

  const [insertedPrompt] = await queryRunner.queryJson<{id: string}>(`
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
    RETURNING id
  `)

  return insertedPrompt?.id ?? null
}
