// Test helper: decodes the rows carried by getReviewServingJsonRowsSql inside a captured SQL statement. The JSON
// literal holds c0..cN keys and the select list aliases them back to column names in order. Values come back as the
// JSON strings the source sends ("12", "true", ISO timestamps) or null; list columns come back as string arrays.
export const decodeReviewServingJsonRows = (statement: string) => {
  return [...statement.matchAll(/from_json_strict\('((?:''|[^'])*)'/gu)].flatMap((match) => {
    const json = (match[1] ?? '[]').replaceAll("''", "'")
    const beforeUnnest = statement.slice(0, statement.lastIndexOf('SELECT unnest(', match.index))
    const columnNames = [
      ...beforeUnnest
        .slice(beforeUnnest.lastIndexOf('SELECT'))
        .matchAll(/struct_extract\(json_row\.r, 'c\d+'\) AS [^)]*\) AS "([^"]+)"/gu),
    ].map((columnMatch) => {
      return columnMatch[1] ?? ''
    })

    return (JSON.parse(json) as Record<string, string | string[] | null>[]).map((row) => {
      return Object.fromEntries(
        columnNames.map((columnName, index) => {
          return [columnName, row[`c${index}`] ?? null]
        }),
      )
    })
  })
}
