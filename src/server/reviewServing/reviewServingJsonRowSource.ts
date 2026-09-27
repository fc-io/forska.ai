import {getSqlLiteral} from '../services/appQueryHelpers.ts'

// Row sources for projector writes. DuckDB spends ~0.2 ms per row just parsing a multi-column
// `VALUES (...), (...)` literal (814 ms for 4,096 ten-column rows), which dominated projector batches.
// The same rows sent as one JSON string literal and unpacked with from_json_strict cost ~38 ms.
// Every value travels as a JSON string (or a list of strings) and is cast to the declared column
// type, which matches how VALUES literals are coerced into the target columns.

export type ReviewServingJsonRowColumn = {name: string; type: string}

type ReviewServingJsonRowValue = string | readonly (string | null)[] | null

const isListColumnType = (type: string) => {
  return type.trim().endsWith('[]')
}

const getJsonRowScalar = (value: unknown, column: ReviewServingJsonRowColumn): string | null => {
  if (value === null || value === undefined) {
    return null
  }

  if (typeof value === 'string') {
    return value
  }

  if (typeof value === 'boolean') {
    return value ? 'true' : 'false'
  }

  if (typeof value === 'number') {
    return Number.isFinite(value) ? String(value) : null
  }

  if (typeof value === 'bigint') {
    return String(value)
  }

  if (value instanceof Date) {
    return value.toISOString()
  }

  if (Array.isArray(value)) {
    throw new Error(`review-serving JSON row source: list value for non-list column ${column.name} (${column.type})`)
  }

  return JSON.stringify(value)
}

const getJsonRowValue = (value: unknown, column: ReviewServingJsonRowColumn): ReviewServingJsonRowValue => {
  if (!isListColumnType(column.type) || value === null || value === undefined) {
    return getJsonRowScalar(value, column)
  }

  if (!Array.isArray(value)) {
    throw new Error(`review-serving JSON row source: non-list value for list column ${column.name} (${column.type})`)
  }

  return value.map((entry) => {
    return getJsonRowScalar(entry, {...column, type: column.type.trim().slice(0, -2)})
  })
}

const getColumnKey = (index: number) => {
  return `c${index}`
}

const getQuotedIdentifier = (name: string) => {
  return `"${name.replaceAll('"', '""')}"`
}

const getJsonRowStructure = (columns: readonly ReviewServingJsonRowColumn[]) => {
  return JSON.stringify([
    Object.fromEntries(
      columns.map((column, index) => {
        return [getColumnKey(index), isListColumnType(column.type) ? ['VARCHAR'] : 'VARCHAR']
      }),
    ),
  ])
}

const getJsonRowSelectList = (columns: readonly ReviewServingJsonRowColumn[], rowAlias: string) => {
  return columns
    .map((column, index) => {
      return `CAST(struct_extract(${rowAlias}, '${getColumnKey(index)}') AS ${column.type}) AS ${getQuotedIdentifier(column.name)}`
    })
    .join(',\n        ')
}

const getInferredScalarType = (value: unknown) => {
  if (value instanceof Date) {
    return 'TIMESTAMPTZ'
  }

  if (typeof value === 'boolean') {
    return 'BOOLEAN'
  }

  if (typeof value === 'bigint') {
    return 'BIGINT'
  }

  if (typeof value === 'number') {
    return Number.isInteger(value) ? 'BIGINT' : 'DOUBLE'
  }

  return 'VARCHAR'
}

const getCommonInferredType = (types: ReadonlySet<string>) => {
  if (types.size === 0) {
    return 'VARCHAR'
  }

  if (types.size === 1) {
    return [...types][0] ?? 'VARCHAR'
  }

  return [...types].every((type) => {
    return type === 'BIGINT' || type === 'DOUBLE'
  })
    ? 'DOUBLE'
    : 'VARCHAR'
}

// Infers a column type from its non-null values the way DuckDB types a VALUES literal: dates become
// TIMESTAMPTZ, booleans BOOLEAN, integers BIGINT, fractions DOUBLE, arrays a VARCHAR-based list, and
// everything else (strings, JSON objects) VARCHAR. The target INSERT/UPDATE casts from there.
export const inferReviewServingJsonRowColumnType = (values: readonly unknown[]) => {
  const scalarTypes = new Set<string>()
  const elementTypes = new Set<string>()
  let hasList = false

  values.forEach((value) => {
    if (value === null || value === undefined) {
      return
    }

    if (Array.isArray(value)) {
      hasList = true
      value.forEach((entry) => {
        if (entry !== null && entry !== undefined) {
          elementTypes.add(getInferredScalarType(entry))
        }
      })
      return
    }

    scalarTypes.add(getInferredScalarType(value))
  })

  if (hasList) {
    return scalarTypes.size === 0 ? `${getCommonInferredType(elementTypes)}[]` : 'VARCHAR'
  }

  return getCommonInferredType(scalarTypes)
}

// Returns a parenthesis-free SELECT producing one typed column per entry in `columns`, in order.
// Use it wherever a `(VALUES ...) AS alias(columns)` row set was used: `FROM (<sql>) AS alias`.
export const getReviewServingJsonRowsSql = (input: {
  columns: readonly ReviewServingJsonRowColumn[]
  rows: readonly (readonly unknown[])[]
}) => {
  if (input.columns.length === 0) {
    throw new Error('review-serving JSON row source needs at least one column')
  }

  if (input.rows.length === 0) {
    return `SELECT
        ${input.columns
          .map((column) => {
            return `CAST(NULL AS ${column.type}) AS ${getQuotedIdentifier(column.name)}`
          })
          .join(',\n        ')}
      WHERE FALSE`
  }

  const json = JSON.stringify(
    input.rows.map((row) => {
      if (row.length !== input.columns.length) {
        throw new Error(
          `review-serving JSON row source: row has ${row.length} values for ${input.columns.length} columns`,
        )
      }

      return Object.fromEntries(
        input.columns.map((column, index) => {
          return [getColumnKey(index), getJsonRowValue(row[index], column)]
        }),
      )
    }),
  )

  return `SELECT
        ${getJsonRowSelectList(input.columns, 'json_row.r')}
      FROM (
        SELECT unnest(from_json_strict(${getSqlLiteral(json)}, ${getSqlLiteral(getJsonRowStructure(input.columns))})) AS r
      ) json_row`
}
