type HtmlTableCell = {colspan: number; rowspan: number; text: string}

const maxTableSpan = 100
const htmlEntities: Record<string, string> = {amp: '&', apos: "'", gt: '>', lt: '<', nbsp: ' ', quot: '"'}

const decodeHtmlEntities = (value: string): string => {
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity: string, name: string) => {
    const lowerName = name.toLowerCase()
    const codePoint = lowerName.startsWith('#x')
      ? Number.parseInt(lowerName.slice(2), 16)
      : lowerName.startsWith('#')
        ? Number.parseInt(lowerName.slice(1), 10)
        : null

    return codePoint === null
      ? (htmlEntities[lowerName] ?? entity)
      : Number.isFinite(codePoint) && codePoint > 0 && codePoint <= 0x10ffff
        ? String.fromCodePoint(codePoint)
        : entity
  })
}

export const getTableCellText = (value: string): string => {
  return value.replace(/\s+/g, ' ').trim().replaceAll('|', '\\|')
}

const getHtmlCellText = (html: string): string => {
  return getTableCellText(decodeHtmlEntities(html.replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]*>/g, ' ')))
}

const getHtmlSpan = (attributes: string, name: string): number => {
  const match = new RegExp(`${name}\\s*=\\s*["']?(\\d+)`, 'i').exec(attributes)
  const value = match ? Number.parseInt(match[1] as string, 10) : 1

  return Math.min(maxTableSpan, Math.max(1, value))
}

const getHtmlTableRows = (html: string): HtmlTableCell[][] => {
  return [...html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map((rowMatch) => {
    return [...(rowMatch[1] ?? '').matchAll(/<(td|th)\b([^>]*)>([\s\S]*?)<\/\1>/gi)].map((cellMatch) => {
      const attributes = cellMatch[2] ?? ''

      return {
        colspan: getHtmlSpan(attributes, 'colspan'),
        rowspan: getHtmlSpan(attributes, 'rowspan'),
        text: getHtmlCellText(cellMatch[3] ?? ''),
      }
    })
  })
}

const getCellKey = (row: number, column: number): string => {
  return `${row}:${column}`
}

const getNextFreeColumn = ({
  column,
  occupied,
  row,
}: {
  column: number
  occupied: Map<string, string>
  row: number
}): number => {
  return occupied.has(getCellKey(row, column)) ? getNextFreeColumn({column: column + 1, occupied, row}) : column
}

const placeHtmlCell = ({
  cell,
  column,
  occupied,
  row,
}: {
  cell: HtmlTableCell
  column: number
  occupied: Map<string, string>
  row: number
}): {column: number; occupied: Map<string, string>} => {
  const start = getNextFreeColumn({column, occupied, row})
  const spanKeys = Array.from({length: cell.rowspan}, (_rowValue, rowOffset) => {
    return Array.from({length: cell.colspan}, (_columnValue, columnOffset) => {
      return getCellKey(row + rowOffset, start + columnOffset)
    })
  }).flat()

  return {
    column: start + cell.colspan,
    occupied: spanKeys.reduce((cells, key) => {
      return cells.set(key, cell.text)
    }, occupied),
  }
}

const getOccupiedCells = (rows: HtmlTableCell[][]): Map<string, string> => {
  return rows.reduce((occupied, cells, row) => {
    return cells.reduce(
      (state, cell) => {
        return placeHtmlCell({cell, column: state.column, occupied: state.occupied, row})
      },
      {column: 0, occupied},
    ).occupied
  }, new Map<string, string>())
}

const getHtmlTableGrid = (rows: HtmlTableCell[][]): string[][] => {
  const occupied = getOccupiedCells(rows)
  const keys = [...occupied.keys()].map((key) => {
    return key.split(':').map(Number) as [number, number]
  })
  const rowCount = Math.max(
    rows.length,
    ...keys.map(([row]) => {
      return row + 1
    }),
  )
  const columnCount = Math.max(
    0,
    ...keys.map(([, column]) => {
      return column + 1
    }),
  )

  return Array.from({length: rowCount}, (_rowValue, row) => {
    return Array.from({length: columnCount}, (_columnValue, column) => {
      return occupied.get(getCellKey(row, column)) ?? ''
    })
  })
}

const getPipeTableRow = (cells: string[]): string => {
  return `| ${cells.join(' | ')} |`
}

const getPaddedRows = (rows: string[][]): string[][] => {
  const columnCount = Math.max(
    0,
    ...rows.map((row) => {
      return row.length
    }),
  )

  return rows.map((row) => {
    return [
      ...row,
      ...Array.from({length: columnCount - row.length}, () => {
        return ''
      }),
    ]
  })
}

export const getPipeTableLines = (rows: string[][]): string[] => {
  const [header, ...body] = getPaddedRows(rows)

  return header && header.length > 0
    ? [
        getPipeTableRow(header),
        getPipeTableRow(
          header.map(() => {
            return '---'
          }),
        ),
        ...body.map(getPipeTableRow),
      ]
    : []
}

const isPipeTableSeparator = (line: string): boolean => {
  return /^\|(\s*:?-{3,}:?\s*\|)+$/.test(line.trim())
}

const getPipeTableCells = (line: string): string[] => {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/(?<!\\)\|$/, '')
    .split(/(?<!\\)\|/)
    .map((cell) => {
      return cell.replace(/\s+/g, ' ').trim()
    })
}

export const getPipeTableRows = (markdown: string): string[][] => {
  return markdown
    .split('\n')
    .filter((line) => {
      return line.trim().startsWith('|') && !isPipeTableSeparator(line)
    })
    .map(getPipeTableCells)
}

export const isHtmlTable = (value: string): boolean => {
  return /<table\b/i.test(value)
}

export const isPipeTable = (value: string): boolean => {
  return value.trim().startsWith('|')
}

export const getHtmlTableGridRows = (html: string): string[][] => {
  return getHtmlTableGrid(getHtmlTableRows(html))
}
