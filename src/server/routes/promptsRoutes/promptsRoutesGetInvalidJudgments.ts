import {getAppDatabaseService} from '../../services/appDatabaseService.ts'
import {escapeSqlString, getDateValue, getJsonValue} from '../../services/appQueryHelpers.ts'

export const promptsRoutesGetInvalidJudgments = async () => {
  // Get prompts with enum types (containing quotes like 'yes' | 'no' | 'unsure')
  const promptsWithTypes = await getAppDatabaseService().queryJson<{
    id: string
    promptHeading: string | null
    type: string | null
  }>(`
      SELECT id, prompt_heading AS promptHeading, type
      FROM app.prompt
      WHERE type IS NOT NULL
        AND type != ''
    `)

  // Parse enum options from prompt types
  const parseEnumOptions = (typeStr: string): string[] | null => {
    // Match quoted strings like 'yes' | 'no' | 'unsure'
    if (!typeStr.includes("'") && !typeStr.includes('"')) return null
    const matches = typeStr.match(/['"]([^'"]+)['"]/g)
    if (!matches || matches.length === 0) return null
    return matches.map((m) => {
      return m.slice(1, -1)
    }) // Remove quotes
  }

  const invalidJudgments: Array<{
    id: string
    articleId: string
    promptId: string
    promptHeading: string | null
    promptType: string | null
    answeredOriginal: string | null
    answeredOriginalAsArray: string[] | null
    createdAt: Date
  }> = []

  // Check each prompt with an enum type
  for (const prompt of promptsWithTypes) {
    if (!prompt.type) continue
    const validOptions = parseEnumOptions(prompt.type)
    if (!validOptions) continue // Skip if not an enum type

    // Find judgments for this prompt where the answer is not in the valid options
    // Include answeredOriginalAsArray for proper validation
    const judgmentRows = await getAppDatabaseService().queryJson<{
      id: string
      articleId: string
      promptId: string
      answeredOriginal: string | null
      answeredOriginalAsArray: unknown
      createdAt: unknown
    }>(`
        SELECT
          id,
          article_id AS articleId,
          prompt_id AS promptId,
          answered_original AS answeredOriginal,
          TO_JSON(answered_original_as_array) AS answeredOriginalAsArray,
          created_at AS createdAt
        FROM app.judgment
        WHERE prompt_id = '${escapeSqlString(prompt.id)}'
          AND (answered_original IS NOT NULL OR answered_original_as_array IS NOT NULL)
          AND is_answered = TRUE
        LIMIT 200
      `)

    for (const judgment of judgmentRows) {
      if (invalidJudgments.length >= 100) break

      let isValid = false

      // If answeredOriginalAsArray is not null, validate against that array
      // (the prompt type expects array values in this case)
      const answeredOriginalAsArray = getJsonValue(judgment.answeredOriginalAsArray)
      if (answeredOriginalAsArray !== null) {
        // Validate each item in the array against valid options
        isValid =
          Array.isArray(answeredOriginalAsArray)
          && answeredOriginalAsArray.every((item) => {
            return typeof item === 'string' && validOptions.includes(item)
          })
      } else if (judgment.answeredOriginal) {
        // Fall back to answeredOriginal for single-value prompts
        const answer = judgment.answeredOriginal

        // Handle legacy array answers stored as JSON strings in answeredOriginal
        if (answer.startsWith('[')) {
          try {
            const parsed = JSON.parse(answer) as unknown
            if (Array.isArray(parsed)) {
              isValid = parsed.every((item) => {
                return typeof item === 'string' && validOptions.includes(item)
              })
            }
          } catch {
            isValid = false
          }
        } else {
          isValid = validOptions.includes(answer)
        }
      }

      if (!isValid) {
        invalidJudgments.push({
          id: judgment.id,
          articleId: judgment.articleId,
          promptId: judgment.promptId,
          promptHeading: prompt.promptHeading,
          promptType: prompt.type,
          answeredOriginal: judgment.answeredOriginal,
          answeredOriginalAsArray: Array.isArray(answeredOriginalAsArray) ? answeredOriginalAsArray : null,
          createdAt: getDateValue(judgment.createdAt) ?? new Date(0),
        })
      }
    }

    if (invalidJudgments.length >= 100) break
  }

  return {success: true, data: invalidJudgments}
}
