export const rejectDuckdbNotImplemented = (feature: string): Promise<never> => {
  return Promise.reject(new Error(`[olap] duckdb not implemented (${feature}); set OLAP_DB=clickhouse`))
}
