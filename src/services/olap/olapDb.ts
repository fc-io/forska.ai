import {env} from '../../server/utils/env.ts'

export const getOlapDb = (): 'clickhouse' | 'duckdb' => {
  const raw = String(process.env['OLAP_DB'] ?? env.OLAP_DB)
    .trim()
    .toLowerCase()
  return raw === 'clickhouse' ? 'clickhouse' : 'duckdb'
}
