/**
 * Test script for the fixed ClickHouse filter.
 * Run with: bun scripts/testClickHouseFilterFix.ts
 */
import {getClickhouseClient} from '../src/services/clickhouse/clickhouseClient.ts'

const main = async () => {
  const client = getClickhouseClient()

  console.log('🔍 Testing the fixed HAVING clause...\n')

  // Test the fixed HAVING clause logic
  const testQuery = `
    SELECT count() as cnt
    FROM judgments
    WHERE (
      (length(answeredOriginalAsArray) > 0 AND hasAny(arrayMap(x -> assumeNotNull(x), arrayFilter(x -> x IS NOT NULL, answeredOriginalAsArray)), ['yes']))
      OR (length(answeredOriginalAsArray) = 0 AND answeredOriginal IN ('yes'))
    )
  `

  console.log('Query:', testQuery.trim())
  console.log('')

  const result = await client.query({query: testQuery, format: 'JSONEachRow'})
  const data = await result.json<{cnt: string}>()

  console.log(`Result: ${data[0]?.cnt ?? '0'} rows match 'yes'`)

  // Also test with multiple values
  const testQuery2 = `
    SELECT count() as cnt
    FROM judgments
    WHERE (
      (length(answeredOriginalAsArray) > 0 AND hasAny(arrayMap(x -> assumeNotNull(x), arrayFilter(x -> x IS NOT NULL, answeredOriginalAsArray)), ['yes', 'potentially']))
      OR (length(answeredOriginalAsArray) = 0 AND answeredOriginal IN ('yes', 'potentially'))
    )
  `

  const result2 = await client.query({query: testQuery2, format: 'JSONEachRow'})
  const data2 = await result2.json<{cnt: string}>()

  console.log(`Result: ${data2[0]?.cnt ?? '0'} rows match 'yes' OR 'potentially'`)

  console.log('\n✅ Test completed!')
  process.exit(0)
}

main().catch((err) => {
  console.error('Error:', err)
  process.exit(1)
})
