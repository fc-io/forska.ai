export const getOlapDb = (): 'clickhouse' | 'duckdb' => {
  const raw = String(process.env['OLAP_DB'] ?? '')
    .trim()
    .toLowerCase()
  return raw === 'duckdb' ? 'duckdb' : 'clickhouse'
}
