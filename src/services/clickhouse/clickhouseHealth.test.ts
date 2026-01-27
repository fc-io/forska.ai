import {expect, mock, test} from 'bun:test'

const clickhouseClientMockRef = {
  current: {
    query: async ({query}: {query: string}) => {
      const json = async () => {
        return query.includes('FROM system.merges')
          ? [{table: 'articles', merges: '2'}]
          : query.includes('GROUP BY table, partition')
            ? [
                {table: 'articles', partition: '202601', parts: '3', rows: '30', bytesOnDisk: '60'},
                {table: 'judgments', partition: '202601', parts: 7, rows: 70, bytesOnDisk: 140},
              ]
            : [
                {table: 'articles', parts: '10', rows: '100', bytesOnDisk: '200', bytesUncompressed: '300'},
                {table: 'judgments', parts: 5, rows: 50, bytesOnDisk: 1000, bytesUncompressed: 2000},
              ]
      }

      return {json}
    },
  },
}

void mock.module('./clickhouseClient.ts', () => {
  return {
    getClickhouseClient: () => {
      return clickhouseClientMockRef.current
    },
  }
})

test('getClickhouseHealth returns per-table merge/parts strings', async () => {
  const {getClickhouseHealth} = await import('./clickhouseHealth.ts')

  const result = await getClickhouseHealth()

  expect(Object.keys(result.tables).sort()).toEqual(['articles', 'judgments'])
  expect(result.tables.articles.merges).toBe('2')
  expect(result.tables.judgments.merges).toBe('0')
  expect(result.tables.articles.parts).toBe('10')
  expect(result.tables.judgments.rows).toBe('50')
  expect(result.tables.articles.topPartitions[0]?.partition).toBe('202601')
})
