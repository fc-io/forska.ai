/**
 * Utilities for determining filter options for article reviews.
 *
 * Two strategies are used:
 * 1. "enum" - Parse the arktype `type` field to extract enum values (e.g., `'yes' | 'no' | 'unsure'`)
 * 2. "database" - Query distinct answered values from the judgments table
 *
 * The strategy is selected based on the prompt's type field:
 * - If type only contains enum values (or arrays of enum values): use "enum" strategy
 * - If type contains 'string' or 'string[]' or is null/empty: use "database" strategy
 */

/**
 * Parse arktype definition to extract possible enum options.
 * Handles:
 * - `'yes' | 'no' | 'unsure'` -> ['yes', 'no', 'unsure']
 * - `('yes' | 'no')[]` -> ['yes', 'no']
 * - `string` -> null (open-ended, use database)
 * - `string[]` -> null (open-ended, use database)
 */
export const parseArktypeOptions = (typeStr: string | null): string[] | null => {
  if (!typeStr) return null

  const trimmed = typeStr.trim()

  // Check for open-ended types that should fall back to database query
  if (isOpenEndedType(trimmed)) {
    return null
  }

  // Match quoted strings: 'value' or "value"
  const matches = trimmed.match(/['"]([^'"]+)['"]/g)
  if (!matches || matches.length === 0) return null

  return matches.map((m) => {
    return m.slice(1, -1) // Remove quotes
  })
}

/**
 * Check if an arktype string represents an open-ended type (string, string[], etc.)
 * that should use database-based filter discovery.
 */
export const isOpenEndedType = (typeStr: string): boolean => {
  const normalized = typeStr.trim().toLowerCase()

  // Direct string types
  if (normalized === 'string' || normalized === 'string[]') {
    return true
  }

  // Check for array notation with string content
  // e.g., "string[]", "(string)[]", etc.
  if (/^\(?\s*string\s*\)?\s*\[\s*\]$/.test(normalized)) {
    return true
  }

  // Check for union types that include 'string' as an option
  // e.g., "string | 'other'" should be considered open-ended
  const unionParts = normalized.split('|').map((p) => {
    return p.trim()
  })
  const hasStringType = unionParts.some((part) => {
    const cleanPart = part.replace(/[()[\]]/g, '').trim()
    return cleanPart === 'string'
  })

  if (hasStringType) {
    return true
  }

  return false
}

/**
 * Determine which filter strategy to use for a given prompt type.
 */
export type FilterStrategy = 'enum' | 'database'

export const getFilterStrategy = (typeStr: string | null): FilterStrategy => {
  if (!typeStr) return 'database'

  const options = parseArktypeOptions(typeStr)
  if (options === null || options.length === 0) {
    return 'database'
  }

  return 'enum'
}

export type PromptFilterInfo = {
  promptId: string
  promptName: string
  type: string | null
  strategy: FilterStrategy
  enumOptions: string[] | null
}

/**
 * Analyze prompts and determine filter strategy for each.
 */
export const analyzePromptTypes = (
  prompts: Array<{id: string; promptHeading: string | null; originalText: string; type: string | null}>,
): PromptFilterInfo[] => {
  return prompts.map((p) => {
    const strategy = getFilterStrategy(p.type)
    const enumOptions = strategy === 'enum' ? parseArktypeOptions(p.type) : null

    return {promptId: p.id, promptName: p.promptHeading || p.originalText, type: p.type, strategy, enumOptions}
  })
}
