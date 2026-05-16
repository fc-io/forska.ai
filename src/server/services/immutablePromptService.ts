import {computePromptContentHash} from '../utils/computePromptContentHash.ts'
import {escapeSqlString, getSqlLiteral} from './appQueryHelpers.ts'

type PromptQueryRunner = {queryJson: <T>(statement: string) => Promise<T[]>; run: (statement: string) => Promise<void>}

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
  const [prompt] = await queryRunner.queryJson<{id: string}>(`
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
    ON CONFLICT(content_hash) DO UPDATE SET
      archived = CASE WHEN excluded.archived = FALSE THEN FALSE ELSE app.prompt.archived END,
      updated_at = CASE WHEN excluded.archived = FALSE AND app.prompt.archived = TRUE THEN now() ELSE app.prompt.updated_at END
    RETURNING id
  `)

  return prompt?.id ?? null
}

export const getImmutablePromptIdByContentHash = async (queryRunner: PromptQueryRunner, contentHash: string) => {
  const [existingPrompt] = await queryRunner.queryJson<{id: string}>(`
    SELECT id
    FROM app.prompt
    WHERE content_hash = ${getSqlLiteral(contentHash)}
    LIMIT 1
  `)

  return existingPrompt?.id ?? null
}
