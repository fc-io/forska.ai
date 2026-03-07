import {tryParseJsonWithSanitization} from './parseSinglePromptJudgment.ts'

export type SinglePromptEvidenceResult = {facts: string[]; quotes: string[]}

const getStringArray = (value: unknown): string[] => {
  return Array.isArray(value)
    ? value.reduce((acc, item) => {
        return typeof item === 'string' && item.trim().length > 0 ? [...acc, item.trim()] : acc
      }, [] as string[])
    : typeof value === 'string' && value.trim().length > 0
      ? [value.trim()]
      : []
}

const getEvidenceObject = (value: unknown): Record<string, unknown> | null => {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }

  if (typeof value === 'string') {
    const nested = tryParseJsonWithSanitization(value)
    return nested.success ? getEvidenceObject(nested.data) : null
  }

  return null
}

const getEvidenceField = (data: Record<string, unknown>, keys: string[]): unknown => {
  return keys.reduce<unknown>((found, key) => {
    return found ?? data[key]
  }, null)
}

const normalizeEvidence = (value: unknown): SinglePromptEvidenceResult => {
  const evidence = getEvidenceObject(value)

  if (!evidence) {
    throw new Error('Evidence response must be a JSON object or JSON string object')
  }

  return {
    facts: getStringArray(getEvidenceField(evidence, ['facts', 'fact'])),
    quotes: getStringArray(getEvidenceField(evidence, ['quotes', 'quote'])),
  }
}

export const parseSinglePromptEvidence = (response: string): SinglePromptEvidenceResult => {
  const parseResult = tryParseJsonWithSanitization(response)

  if (!parseResult.success) {
    throw new Error(parseResult.originalError)
  }

  return normalizeEvidence(parseResult.data)
}
