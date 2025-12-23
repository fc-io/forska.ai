/**
 * Test script for ClickHouse articles reviews query.
 * Run with: bun scripts/testClickHouseQuery.ts
 */
import {queryArticlesReviewsFromClickHouse} from '../src/services/clickhouse/articlesReviewsClickHouse.ts'

// 2025 Clinical healthcare - has 93K curated articles (tests temp table code path)
const TEST_PROJECT_ID = '38b2dfb7-a8bc-4dd0-922f-2bf6c46a2dc9'

const main = async () => {
  console.log('🔍 Testing ClickHouse articles reviews query...')
  console.log(`Project ID: ${TEST_PROJECT_ID}`)
  console.log('')

  const startTime = performance.now()

  try {
    const result = await queryArticlesReviewsFromClickHouse({
      projectId: TEST_PROJECT_ID,
      page: 1,
      limit: 10,
      prompts: {},
    })

    const elapsed = performance.now() - startTime

    console.log('')
    console.log('=== RESULTS ===')
    console.log(`Total time: ${elapsed.toFixed(0)}ms`)
    console.log(`Articles returned: ${result.data.length}`)

    if (result.data.length > 0) {
      console.log('')
      console.log('First article:')
      const first = result.data[0]
      console.log(`  ID: ${first.id}`)
      console.log(`  Title: ${first.articleTitle?.substring(0, 60)}...`)
      console.log(`  Created: ${first.articleCreatedAt}`)
      console.log(`  Judgments: ${first.judgments.length}`)
      console.log(`  Prompt IDs: ${first.judgedPromptIds.join(', ')}`)
      console.log(`  Fully judged: ${first.isFullyJudged}`)
    }
  } catch (error) {
    console.error('❌ Error:', error)
    process.exit(1)
  }

  console.log('')
  console.log('✅ Test completed!')
  process.exit(0)
}

main()
