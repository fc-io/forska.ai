import {getClickhouseClient} from './clickhouseClient.ts'

const HEALTH_TABLES = ['articles', 'judgments'] as const
const HEALTH_TABLE_MAP = {articles: 'articles', judgments: 'judgments_raw'} as const

type HealthTable = (typeof HEALTH_TABLES)[number]

type PartsSummaryRow = {
  table: string
  parts: string | number
  rows: string | number
  bytesOnDisk: string | number
  bytesUncompressed: string | number
}

type PartsTopPartitionRow = {
  table: string
  partition: string
  parts: string | number
  rows: string | number
  bytesOnDisk: string | number
}

type MergesSummaryRow = {table: string; merges: string | number}

export type ClickhouseTableHealth = {
  table: HealthTable
  parts: string
  rows: string
  bytesOnDisk: string
  bytesUncompressed: string
  merges: string
  topPartitions: Array<{partition: string; parts: string; rows: string; bytesOnDisk: string}>
}

export type ClickhouseHealth = {queriedAt: string; tables: Record<HealthTable, ClickhouseTableHealth>}

const toHealthTable = (table: string): HealthTable | null => {
  if (table === HEALTH_TABLE_MAP.articles) return 'articles'
  return table === HEALTH_TABLE_MAP.judgments ? 'judgments' : null
}

const toIntString = (value: unknown): string => {
  if (typeof value === 'string') return value
  if (typeof value === 'number') return String(Math.trunc(value))
  if (typeof value === 'bigint') return value.toString()
  return '0'
}

const emptyHealthForTable = (table: HealthTable): ClickhouseTableHealth => {
  return {table, parts: '0', rows: '0', bytesOnDisk: '0', bytesUncompressed: '0', merges: '0', topPartitions: []}
}

export const getClickhouseHealth = async (): Promise<ClickhouseHealth> => {
  const client = getClickhouseClient()
  const tableList = Object.values(HEALTH_TABLE_MAP)
    .map((t) => {
      return `'${t}'`
    })
    .join(', ')

  const partsSummaryQuery = `
    SELECT
      table,
      count() as parts,
      sum(rows) as rows,
      sum(bytes_on_disk) as bytesOnDisk,
      sum(data_uncompressed_bytes) as bytesUncompressed
    FROM system.parts
    WHERE active AND database = 'forska' AND table IN (${tableList})
    GROUP BY table
  `

  const topPartitionsQuery = `
    SELECT
      table,
      partition,
      count() as parts,
      sum(rows) as rows,
      sum(bytes_on_disk) as bytesOnDisk
    FROM system.parts
    WHERE active AND database = 'forska' AND table IN (${tableList})
    GROUP BY table, partition
    ORDER BY table ASC, parts DESC
    LIMIT 5 BY table
  `

  const mergesSummaryQuery = `
    SELECT
      table,
      count() as merges
    FROM system.merges
    WHERE database = 'forska' AND table IN (${tableList})
    GROUP BY table
  `

  const [partsSummaryResult, topPartitionsResult, mergesSummaryResult] = await Promise.all([
    client.query({query: partsSummaryQuery, format: 'JSONEachRow'}),
    client.query({query: topPartitionsQuery, format: 'JSONEachRow'}),
    client.query({query: mergesSummaryQuery, format: 'JSONEachRow'}),
  ])

  const partsSummaryRows = await partsSummaryResult.json<PartsSummaryRow>()
  const topPartitionsRows = await topPartitionsResult.json<PartsTopPartitionRow>()
  const mergesSummaryRows = await mergesSummaryResult.json<MergesSummaryRow>()

  const mergesByTable = mergesSummaryRows.reduce(
    (acc, row) => {
      const table = toHealthTable(row.table)
      return table ? {...acc, [table]: toIntString(row.merges)} : acc
    },
    {} as Partial<Record<HealthTable, string>>,
  )

  const topPartitionsByTable = topPartitionsRows.reduce(
    (acc, row) => {
      const table = toHealthTable(row.table)
      if (!table) return acc
      const next = [
        ...(acc[table] ?? []),
        {
          partition: row.partition,
          parts: toIntString(row.parts),
          rows: toIntString(row.rows),
          bytesOnDisk: toIntString(row.bytesOnDisk),
        },
      ]
      return {...acc, [table]: next}
    },
    {} as Partial<Record<HealthTable, Array<{partition: string; parts: string; rows: string; bytesOnDisk: string}>>>,
  )

  const healthByTable = partsSummaryRows.reduce(
    (acc, row) => {
      const table = toHealthTable(row.table)
      return table
        ? {
            ...acc,
            [table]: {
              table,
              parts: toIntString(row.parts),
              rows: toIntString(row.rows),
              bytesOnDisk: toIntString(row.bytesOnDisk),
              bytesUncompressed: toIntString(row.bytesUncompressed),
              merges: mergesByTable[table] ?? '0',
              topPartitions: topPartitionsByTable[table] ?? [],
            },
          }
        : acc
    },
    {} as Partial<Record<HealthTable, ClickhouseTableHealth>>,
  )

  return {
    queriedAt: new Date().toISOString(),
    tables: HEALTH_TABLES.reduce(
      (acc, table) => {
        return {...acc, [table]: healthByTable[table] ?? emptyHealthForTable(table)}
      },
      {} as Record<HealthTable, ClickhouseTableHealth>,
    ),
  }
}
