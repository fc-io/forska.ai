const duckdbIndexedRowDeletingStatementPattern =
  /\b(?:DELETE\s+FROM|MERGE\s+INTO|UPDATE|INSERT\s+OR\s+IGNORE\s+INTO)\b/iu

export const canDuckdbStatementDeleteIndexedRows = (statement: string) => {
  return duckdbIndexedRowDeletingStatementPattern.test(statement)
}
