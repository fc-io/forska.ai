import type {HumanJudgmentMode} from '../../../../db/schemaTypes.ts'

export const getTrimmedValue = (value: string | null | undefined) => {
  const trimmedValue = value?.trim() ?? ''

  return trimmedValue.length > 0 ? trimmedValue : null
}

export const getDecodedJsonMetadata = <T>(encodedValue: string | null | undefined): T | null => {
  const value = getTrimmedValue(encodedValue)

  if (!value) {
    return null
  }

  try {
    return JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as T
  } catch {
    return null
  }
}

export const getMetadataString = (metadata: Record<string, unknown> | null, key: string) => {
  const value = metadata?.[key]

  return typeof value === 'string' && value.trim().length > 0 ? value : null
}

export const getMetadataBoolean = (metadata: Record<string, unknown> | null, key: string) => {
  const value = metadata?.[key]

  return typeof value === 'boolean' ? value : null
}

export const getMetadataNumber = (metadata: Record<string, unknown> | null, key: string) => {
  const value = metadata?.[key]

  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

export const getResolutionMode = (projectMetadata: Record<string, unknown> | null): HumanJudgmentMode => {
  return getMetadataString(projectMetadata, 'humanJudgmentMode') === 'prompt' ? 'prompt' : 'summary'
}

const judgmentContextIdPattern = /^[0-9a-f]{64}$/

export const getJudgmentContextIdMetadata = (metadata: Record<string, unknown> | null) => {
  const judgmentContextId = getMetadataString(metadata, 'judgmentContextId')

  return judgmentContextId && judgmentContextIdPattern.test(judgmentContextId) ? judgmentContextId : null
}

export const getArticleMetadata = (
  metadataByArticleId: ReadonlyMap<string, Record<string, unknown>>,
  articleId: string | null,
) => {
  return articleId ? (metadataByArticleId.get(articleId) ?? null) : null
}
