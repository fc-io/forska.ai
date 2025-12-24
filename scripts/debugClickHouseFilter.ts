/**
 * Debug script for ClickHouse filter issues.
 * Run with: bun scripts/debugClickHouseFilter.ts
 */
import {getClickhouseClient} from '../src/services/clickhouse/clickhouseClient.ts'

const main = async () => {
  const client = getClickhouseClient()

  console.log('🔍 Debugging ClickHouse answeredOriginalAsArray...\n')

  // 1. Check a sample of answeredOriginalAsArray values
  console.log('=== Sample of answeredOriginalAsArray values ===')
  const sampleQuery = `
    SELECT
      answeredOriginal,
      answeredOriginalAsArray,
      length(answeredOriginalAsArray) as arrayLen
    FROM judgments
    WHERE answeredOriginal IS NOT NULL
    LIMIT 20
  `
  const sampleResult = await client.query({query: sampleQuery, format: 'JSONEachRow'})
  const sampleData = await sampleResult.json<{
    answeredOriginal: string | null
    answeredOriginalAsArray: (string | null)[]
    arrayLen: number
  }>()

  for (const row of sampleData) {
    console.log(`  Original: "${row.answeredOriginal}" | Array: ${JSON.stringify(row.answeredOriginalAsArray)} | Len: ${row.arrayLen}`)
  }

  // 2. Check distinct answers
  console.log('\n=== Distinct answeredOriginal values (top 20) ===')
  const distinctQuery = `
    SELECT
      answeredOriginal,
      count() as cnt
    FROM judgments
    WHERE answeredOriginal IS NOT NULL
    GROUP BY answeredOriginal
    ORDER BY cnt DESC
    LIMIT 20
  `
  const distinctResult = await client.query({query: distinctQuery, format: 'JSONEachRow'})
  const distinctData = await distinctResult.json<{answeredOriginal: string; cnt: string}>()

  for (const row of distinctData) {
    console.log(`  "${row.answeredOriginal}": ${row.cnt}`)
  }

  // 3. Test hasAny with different formulations
  console.log('\n=== Testing hasAny formulations ===')

  // Test 1: Direct hasAny (broken)
  const test1 = `
    SELECT count() as cnt
    FROM judgments
    WHERE hasAny(answeredOriginalAsArray, ['yes'])
  `
  const test1Result = await client.query({query: test1, format: 'JSONEachRow'})
  const test1Data = await test1Result.json<{cnt: string}>()
  console.log(`  hasAny(answeredOriginalAsArray, ['yes']): ${test1Data[0]?.cnt ?? '0'}`)

  // Test 2: With arrayFilter/assumeNotNull (my fix)
  const test2 = `
    SELECT count() as cnt
    FROM judgments
    WHERE hasAny(arrayMap(x -> assumeNotNull(x), arrayFilter(x -> x IS NOT NULL, answeredOriginalAsArray)), ['yes'])
  `
  const test2Result = await client.query({query: test2, format: 'JSONEachRow'})
  const test2Data = await test2Result.json<{cnt: string}>()
  console.log(`  hasAny(arrayMap(x->assumeNotNull(x), arrayFilter(...)), ['yes']): ${test2Data[0]?.cnt ?? '0'}`)

  // Test 3: Check if 'Yes' (capital) exists
  const test3 = `
    SELECT count() as cnt
    FROM judgments
    WHERE answeredOriginal = 'Yes'
  `
  const test3Result = await client.query({query: test3, format: 'JSONEachRow'})
  const test3Data = await test3Result.json<{cnt: string}>()
  console.log(`  answeredOriginal = 'Yes' (capital Y): ${test3Data[0]?.cnt ?? '0'}`)

  // Test 4: Check if 'yes' (lowercase) exists
  const test4 = `
    SELECT count() as cnt
    FROM judgments
    WHERE answeredOriginal = 'yes'
  `
  const test4Result = await client.query({query: test4, format: 'JSONEachRow'})
  const test4Data = await test4Result.json<{cnt: string}>()
  console.log(`  answeredOriginal = 'yes' (lowercase): ${test4Data[0]?.cnt ?? '0'}`)

  // Test 5: Using has on answeredOriginal (as fallback)
  const test5 = `
    SELECT count() as cnt
    FROM judgments
    WHERE lower(answeredOriginal) = 'yes'
  `
  const test5Result = await client.query({query: test5, format: 'JSONEachRow'})
  const test5Data = await test5Result.json<{cnt: string}>()
  console.log(`  lower(answeredOriginal) = 'yes': ${test5Data[0]?.cnt ?? '0'}`)

  // Test 6: Check if array is empty
  const test6 = `
    SELECT
      countIf(length(answeredOriginalAsArray) = 0) as emptyCount,
      countIf(length(answeredOriginalAsArray) > 0) as nonEmptyCount,
      count() as total
    FROM judgments
  `
  const test6Result = await client.query({query: test6, format: 'JSONEachRow'})
  const test6Data = await test6Result.json<{emptyCount: string; nonEmptyCount: string; total: string}>()
  console.log(`\n=== Array Statistics ===`)
  console.log(`  Empty arrays: ${test6Data[0]?.emptyCount ?? '0'}`)
  console.log(`  Non-empty arrays: ${test6Data[0]?.nonEmptyCount ?? '0'}`)
  console.log(`  Total: ${test6Data[0]?.total ?? '0'}`)

  console.log('\n✅ Debug completed!')
  process.exit(0)
}

main().catch((err) => {
  console.error('Error:', err)
  process.exit(1)
})
