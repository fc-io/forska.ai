/**
 * Script to find specific articles with unexpected judgment answers
 *
 * Shows article details and the unexpected answers they have
 */
import {and, eq, isNotNull, isNull, sql} from 'drizzle-orm'

import {articles, judgments, prompts, projectPrompts} from '../src/db/schema.ts'
import {getDatabase} from '../src/server/utils/getDatabase.ts'

const parseArktypeOptions = (typeStr: string | null): string[] => {
  if (!typeStr) return []
  const matches = typeStr.match(/['"]([^'"]+)['"]/g)
  return (
    matches?.map((m) => {
      return m.slice(1, -1)
    }) ?? []
  )
}

const findArticlesWithUnexpectedAnswers = async (projectId: string, promptId?: string) => {
  const db = getDatabase()

  console.log(`Finding articles with unexpected answers for project: ${projectId}`)

  // Get prompts for the project
  const projectPromptRows = await db
    .select({id: prompts.id, promptHeading: prompts.promptHeading, type: prompts.type})
    .from(projectPrompts)
    .innerJoin(prompts, eq(projectPrompts.promptId, prompts.id))
    .where(and(eq(projectPrompts.projectId, projectId), eq(projectPrompts.enabled, true), isNotNull(prompts.type)))

  const promptsToCheck = promptId
    ? projectPromptRows.filter((p) => {
        return p.id === promptId
      })
    : projectPromptRows

  if (promptsToCheck.length === 0) {
    console.log('No prompts found with defined types')
    return
  }

  for (const prompt of promptsToCheck) {
    const expectedOptions = parseArktypeOptions(prompt.type)
    if (expectedOptions.length === 0) continue

    console.log(`\n=== Prompt: ${prompt.promptHeading || prompt.id} ===`)
    console.log(`Expected options: ${expectedOptions.join(', ')}`)

    // Find judgments with unexpected answers
    const unexpectedJudgments = await db
      .select({
        articleId: articles.id,
        articleTitle: articles.articleTitle,
        articleExternalId: articles.articleId,
        answeredOriginal: judgments.answeredOriginal,
        createdAt: judgments.createdAt,
      })
      .from(judgments)
      .innerJoin(articles, eq(judgments.articleId, articles.id))
      .where(
        and(
          eq(judgments.promptId, prompt.id),
          isNull(judgments.deletedAt),
          sql`NOT (${judgments.answeredOriginal} = ANY(ARRAY[${sql.join(
            expectedOptions.map((opt) => {
              return sql`${opt}::text`
            }),
            sql`, `,
          )}]) OR ${judgments.answeredOriginal} IS NULL)`,
        ),
      )
      .limit(20) // Limit to first 20 articles

    if (unexpectedJudgments.length > 0) {
      console.log(`\nFound ${unexpectedJudgments.length}+ articles with unexpected answers (showing first 20):`)
      for (const j of unexpectedJudgments) {
        console.log(`  - ${j.articleTitle?.substring(0, 60) || 'Untitled'} (${j.articleExternalId || j.articleId})`)
        console.log(`    Answer: "${j.answeredOriginal}" (expected one of: ${expectedOptions.join(', ')})`)
        console.log(`    Judged at: ${j.createdAt}`)
      }
    } else {
      console.log('No unexpected answers found')
    }

    // Also check for NULL/empty answers
    const nullAnswers = await db
      .select({
        articleId: articles.id,
        articleTitle: articles.articleTitle,
        articleExternalId: articles.articleId,
        answeredOriginal: judgments.answeredOriginal,
      })
      .from(judgments)
      .innerJoin(articles, eq(judgments.articleId, articles.id))
      .where(
        and(
          eq(judgments.promptId, prompt.id),
          isNull(judgments.deletedAt),
          sql`(${judgments.answeredOriginal} IS NULL OR ${judgments.answeredOriginal} = '')`,
        ),
      )
      .limit(20)

    if (nullAnswers.length > 0) {
      console.log(`\nFound ${nullAnswers.length}+ articles with NULL/empty answers (showing first 20):`)
      for (const j of nullAnswers) {
        console.log(`  - ${j.articleTitle?.substring(0, 60) || 'Untitled'} (${j.articleExternalId || j.articleId})`)
        console.log(`    Answer: ${j.answeredOriginal === null ? 'NULL' : 'empty string'}`)
      }
    }
  }
}

// Run the script
const projectId = process.argv[2]
const promptId = process.argv[3]

if (!projectId) {
  console.error('Usage: bun run scripts/findArticlesWithUnexpectedAnswers.ts <projectId> [promptId]')
  process.exit(1)
}

findArticlesWithUnexpectedAnswers(projectId, promptId)
  .then(() => {
    console.log('\nSearch complete!')
    process.exit(0)
  })
  .catch((error) => {
    console.error('Error:', error)
    process.exit(1)
  })
