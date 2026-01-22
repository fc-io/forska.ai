/**
 * Script to investigate unexpected judgment answer values
 *
 * Finds judgments where the answer doesn't match any of the prompt's defined options
 */
import {isNotNull, sql} from 'drizzle-orm'

import {judgments, prompts} from '../src/db/schema.ts'
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

const investigateUnexpectedAnswers = async () => {
  const db = getDatabase()

  console.log('Fetching prompts with defined types...')

  const allPrompts = await db
    .select({
      id: prompts.id,
      promptHeading: prompts.promptHeading,
      type: prompts.type,
    })
    .from(prompts)
    .where(isNotNull(prompts.type))

  console.log(`Found ${allPrompts.length} prompts with defined types`)

  const results: Array<{
    promptId: string
    promptHeading: string
    expectedOptions: string[]
    unexpectedAnswers: Array<{value: string | null; count: number}>
    totalJudgments: number
  }> = []

  for (const prompt of allPrompts) {

    const expectedOptions = parseArktypeOptions(prompt.type)
    if (expectedOptions.length === 0) continue

    console.log(`\nAnalyzing prompt: ${prompt.promptHeading || prompt.id}`)
    console.log(`Expected options: ${expectedOptions.join(', ')}`)

    // Get all distinct answers for this prompt
    const answersQuery = await db
      .select({
        answeredOriginal: judgments.answeredOriginal,
        count: sql<number>`COUNT(*)::int`,
      })
      .from(judgments)
      .where(sql`${judgments.promptId} = ${prompt.id}::uuid AND ${judgments.deletedAt} IS NULL`)
      .groupBy(judgments.answeredOriginal)

    const totalJudgments = answersQuery.reduce((sum, a) => {
      return sum + a.count
    }, 0)

    // Find unexpected answers
    const unexpectedAnswers = answersQuery
      .filter((a) => {
        const answer = a.answeredOriginal
        if (answer === null) return true // null is unexpected
        if (answer === '') return true // empty is unexpected
        return !expectedOptions.includes(answer) // not in expected options
      })
      .map((a) => {
        return {value: a.answeredOriginal, count: a.count}
      })
      .sort((a, b) => {
        return b.count - a.count
      }) // Sort by count descending

    if (unexpectedAnswers.length > 0) {
      console.log(`Found ${unexpectedAnswers.length} unexpected answer types:`)
      for (const ua of unexpectedAnswers) {
        console.log(`  - "${ua.value}" (${ua.count} judgments)`)
      }

      results.push({
        promptId: prompt.id,
        promptHeading: prompt.promptHeading || 'Untitled',
        expectedOptions,
        unexpectedAnswers,
        totalJudgments,
      })
    }
  }

  console.log('\n=== SUMMARY ===')
  console.log(`Total prompts with defined types: ${allPrompts.length}`)
  console.log(`Prompts with unexpected answers: ${results.length}`)

  if (results.length > 0) {
    console.log('\nDetails by prompt:')
    for (const result of results) {
      const unexpectedCount = result.unexpectedAnswers.reduce((sum, ua) => {
        return sum + ua.count
      }, 0)
      const percentUnexpected = ((unexpectedCount / result.totalJudgments) * 100).toFixed(1)
      console.log(`\n${result.promptHeading} (${result.promptId})`)
      console.log(`  Total judgments: ${result.totalJudgments}`)
      console.log(`  Unexpected: ${unexpectedCount} (${percentUnexpected}%)`)
      console.log(`  Expected options: ${result.expectedOptions.join(', ')}`)
      console.log('  Unexpected values:')
      for (const ua of result.unexpectedAnswers) {
        console.log(`    - "${ua.value}": ${ua.count}`)
      }
    }
  }

  return results
}

// Run the investigation
investigateUnexpectedAnswers()
  .then(() => {
    console.log('\nInvestigation complete!')
    process.exit(0)
  })
  .catch((error) => {
    console.error('Error:', error)
    process.exit(1)
  })
