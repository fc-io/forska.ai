import {randomUUID} from 'node:crypto'

type DuckdbStatementTokenKind = 'number' | 'quoted' | 'string' | 'symbol' | 'word'

type DuckdbStatementToken = {kind: DuckdbStatementTokenKind; value: string}

type DuckdbStatementScan = {
  appTables: Set<string>
  depth: number
  doUpdateCount: number
  leading: DuckdbStatementToken[]
  mainLeading: DuckdbStatementToken[]
  pendingReplace: boolean
  previous: DuckdbStatementToken | null
  previousBefore: DuckdbStatementToken | null
  renameTargets: string[]
  uncertain: boolean
  writeKeywordCount: number
}

export type DuckdbStatementTableWriteEffect =
  | {kind: 'epoch'; reason: string}
  | {kind: 'none'}
  | {kind: 'searchPath'}
  | {kind: 'transactionBegin'}
  | {kind: 'transactionEnd'}
  | {kind: 'write'; tables: string[]}

export type DuckdbTrackedStatement = {connection: object; effects: DuckdbStatementTableWriteEffect[]}

export type DuckdbTableWriteTrackerSnapshot = {
  available: boolean
  counters: Record<string, number>
  epoch: string
  epochReason: string
  externalCounters: Record<string, number>
}

type DuckdbOpenTransaction = {renewEpochAtEnd: boolean; tables: Set<string>}

type DuckdbTableWriteTrackerState = {
  counters: Map<string, number>
  epoch: string
  epochReason: string
  externalCounters: Map<string, number>
  identity: string | null
  open: boolean
  searchPathChanged: boolean
  transactionsByConnection: Map<object, DuckdbOpenTransaction>
}

const duckdbStatementLeadingTokenLimit = 16

const duckdbWriteKeywords = new Set([
  'alter',
  'copy',
  'create',
  'delete',
  'drop',
  'insert',
  'merge',
  'rename',
  'replace',
  'truncate',
  'update',
])

const duckdbEpochLeadingKeywords = new Set(['attach', 'call', 'detach', 'execute', 'import'])

const duckdbCteMainStatementKeywords = new Set(['delete', 'insert', 'merge', 'select', 'update'])

const duckdbTransactionEndKeywords = new Set(['abort', 'commit', 'end', 'rollback'])

const duckdbSearchPathSettingNames = new Set(['schema', 'search_path'])

const duckdbSettingStatementKeywords = new Set(['pragma', 'reset', 'set'])

const getNewDuckdbTableWriteTrackerEpoch = () => {
  return randomUUID()
}

const duckdbTableWriteTrackerState: DuckdbTableWriteTrackerState = {
  counters: new Map(),
  epoch: getNewDuckdbTableWriteTrackerEpoch(),
  epochReason: 'process-start',
  externalCounters: new Map(),
  identity: null,
  open: false,
  searchPathChanged: false,
  transactionsByConnection: new Map(),
}

const getEmptyDuckdbStatementScan = (): DuckdbStatementScan => {
  return {
    appTables: new Set(),
    depth: 0,
    doUpdateCount: 0,
    leading: [],
    mainLeading: [],
    pendingReplace: false,
    previous: null,
    previousBefore: null,
    renameTargets: [],
    uncertain: false,
    writeKeywordCount: 0,
  }
}

const isDuckdbNameToken = (token: DuckdbStatementToken | null | undefined) => {
  return token?.kind === 'word' || token?.kind === 'quoted'
}

const isDuckdbWordToken = (token: DuckdbStatementToken | null | undefined, value: string) => {
  return token?.kind === 'word' && token.value === value
}

const isDuckdbSymbolToken = (token: DuckdbStatementToken | null | undefined, value: string) => {
  return token?.kind === 'symbol' && token.value === value
}

const settleDuckdbPendingReplace = (scan: DuckdbStatementScan, token: DuckdbStatementToken | null) => {
  if (scan.pendingReplace && !isDuckdbSymbolToken(token, '(')) {
    scan.writeKeywordCount += 1
  }

  scan.pendingReplace = false
}

const isDuckdbMainStatementToken = (scan: DuckdbStatementScan, token: DuckdbStatementToken) => {
  return (
    scan.mainLeading.length > 0
    || (scan.depth === 0
      && isDuckdbWordToken(scan.leading[0], 'with')
      && token.kind === 'word'
      && duckdbCteMainStatementKeywords.has(token.value))
  )
}

const recordDuckdbStatementToken = (scan: DuckdbStatementScan, token: DuckdbStatementToken) => {
  settleDuckdbPendingReplace(scan, token)

  if (token.kind === 'word' && duckdbWriteKeywords.has(token.value)) {
    scan.pendingReplace = token.value === 'replace'
    scan.writeKeywordCount += token.value === 'replace' ? 0 : 1
    scan.doUpdateCount += token.value === 'update' && isDuckdbWordToken(scan.previous, 'do') ? 1 : 0
  }

  if (
    isDuckdbNameToken(token)
    && isDuckdbSymbolToken(scan.previous, '.')
    && isDuckdbNameToken(scan.previousBefore)
    && scan.previousBefore?.value === 'app'
  ) {
    scan.appTables.add(`app.${token.value}`)
  }

  if (
    isDuckdbNameToken(token)
    && isDuckdbWordToken(scan.previous, 'to')
    && isDuckdbWordToken(scan.previousBefore, 'rename')
  ) {
    scan.renameTargets.push(token.value)
  }

  if (scan.leading.length < duckdbStatementLeadingTokenLimit) {
    scan.leading.push(token)
  }

  if (isDuckdbMainStatementToken(scan, token) && scan.mainLeading.length < duckdbStatementLeadingTokenLimit) {
    scan.mainLeading.push(token)
  }

  scan.depth = Math.max(
    0,
    scan.depth + (isDuckdbSymbolToken(token, '(') ? 1 : 0) - (isDuckdbSymbolToken(token, ')') ? 1 : 0),
  )
  scan.previousBefore = scan.previous
  scan.previous = token
}

const getDuckdbQualifiedNameAt = (tokens: DuckdbStatementToken[], index: number) => {
  const first = tokens[index]
  const parts = isDuckdbNameToken(first) && first !== undefined ? [first.value] : []
  const readNextPart = (partIndex: number, currentParts: string[]): {nextIndex: number; parts: string[]} => {
    const separator = tokens[partIndex]
    const part = tokens[partIndex + 1]

    return currentParts.length < 3 && isDuckdbSymbolToken(separator, '.') && isDuckdbNameToken(part) && part
      ? readNextPart(partIndex + 2, [...currentParts, part.value])
      : {nextIndex: partIndex, parts: currentParts}
  }
  const name = parts.length === 0 ? null : readNextPart(index + 1, parts)

  return name === null || name.nextIndex >= duckdbStatementLeadingTokenLimit ? null : name.parts
}

const getDuckdbAppTablesForQualifiedName = (parts: string[]) => {
  const schemaName = parts.length === 3 ? parts[1] : parts.length === 2 ? parts[0] : null

  return schemaName === 'app' ? [`app.${parts.at(-1)}`] : []
}

const getDuckdbInsertWriteTarget = (scan: DuckdbStatementScan, tokens: DuckdbStatementToken[]) => {
  const hasConflictClause =
    isDuckdbWordToken(tokens[1], 'or')
    && (isDuckdbWordToken(tokens[2], 'replace') || isDuckdbWordToken(tokens[2], 'ignore'))
  const intoIndex = hasConflictClause ? 3 : 1
  const allowedWriteKeywordCount = 1 + (isDuckdbWordToken(tokens[2], 'replace') ? 1 : 0) + scan.doUpdateCount
  const parts = isDuckdbWordToken(tokens[intoIndex], 'into') ? getDuckdbQualifiedNameAt(tokens, intoIndex + 1) : null

  return parts === null || scan.writeKeywordCount !== allowedWriteKeywordCount
    ? null
    : getDuckdbAppTablesForQualifiedName(parts)
}

const getDuckdbSingleTargetWriteTarget = (
  scan: DuckdbStatementScan,
  tokens: DuckdbStatementToken[],
  nameIndex: number,
) => {
  const parts = getDuckdbQualifiedNameAt(tokens, nameIndex)

  return parts === null || scan.writeKeywordCount !== 1 ? null : getDuckdbAppTablesForQualifiedName(parts)
}

const getDuckdbCreateRelationWriteTarget = (scan: DuckdbStatementScan) => {
  const tokens = scan.leading
  const hasOrReplace = isDuckdbWordToken(tokens[1], 'or') && isDuckdbWordToken(tokens[2], 'replace')
  const kindIndex =
    (hasOrReplace ? 3 : 1)
    + (isDuckdbWordToken(tokens[hasOrReplace ? 3 : 1], 'temp')
    || isDuckdbWordToken(tokens[hasOrReplace ? 3 : 1], 'temporary')
      ? 1
      : 0)
  const hasRelationKind = isDuckdbWordToken(tokens[kindIndex], 'table') || isDuckdbWordToken(tokens[kindIndex], 'view')
  const hasIfNotExists =
    isDuckdbWordToken(tokens[kindIndex + 1], 'if')
    && isDuckdbWordToken(tokens[kindIndex + 2], 'not')
    && isDuckdbWordToken(tokens[kindIndex + 3], 'exists')
  const parts = hasRelationKind ? getDuckdbQualifiedNameAt(tokens, kindIndex + (hasIfNotExists ? 4 : 1)) : null

  return parts === null || scan.writeKeywordCount !== (hasOrReplace ? 2 : 1)
    ? null
    : getDuckdbAppTablesForQualifiedName(parts)
}

const getDuckdbStatementFormTokens = (scan: DuckdbStatementScan) => {
  return isDuckdbWordToken(scan.leading[0], 'with') ? scan.mainLeading : scan.leading
}

const getDuckdbPreciseWriteTarget = (scan: DuckdbStatementScan) => {
  const tokens = getDuckdbStatementFormTokens(scan)
  const [first, second] = tokens

  return isDuckdbWordToken(first, 'insert')
    ? getDuckdbInsertWriteTarget(scan, tokens)
    : isDuckdbWordToken(first, 'update')
      ? getDuckdbSingleTargetWriteTarget(scan, tokens, 1)
      : isDuckdbWordToken(first, 'delete') && isDuckdbWordToken(second, 'from')
        ? getDuckdbSingleTargetWriteTarget(scan, tokens, 2)
        : isDuckdbWordToken(first, 'create')
          ? getDuckdbCreateRelationWriteTarget(scan)
          : null
}

const getDuckdbFallbackWriteTables = (scan: DuckdbStatementScan) => {
  const appTables = [...scan.appTables]
  const renamedAppTables =
    appTables.length === 0
      ? []
      : scan.renameTargets.map((name) => {
          return `app.${name}`
        })

  return [...new Set([...appTables, ...renamedAppTables])]
}

const isDuckdbSchemaChangeStatement = (tokens: DuckdbStatementToken[]) => {
  const [first, second, third, fourth] = tokens

  return (
    ((isDuckdbWordToken(first, 'drop') || isDuckdbWordToken(first, 'alter')) && isDuckdbWordToken(second, 'schema'))
    || (isDuckdbWordToken(first, 'create')
      && isDuckdbWordToken(second, 'or')
      && isDuckdbWordToken(third, 'replace')
      && isDuckdbWordToken(fourth, 'schema'))
  )
}

const isDuckdbSearchPathSettingToken = (token: DuckdbStatementToken) => {
  return isDuckdbNameToken(token) && duckdbSearchPathSettingNames.has(token.value)
}

const isDuckdbSearchPathStatement = (tokens: DuckdbStatementToken[]) => {
  const [first, ...rest] = tokens

  return (
    isDuckdbWordToken(first, 'use')
    || (first?.kind === 'word'
      && duckdbSettingStatementKeywords.has(first.value)
      && rest.slice(0, 3).some(isDuckdbSearchPathSettingToken))
  )
}

const getDuckdbEpochStatementReason = (scan: DuckdbStatementScan) => {
  const [first, second, third] = scan.leading

  return scan.uncertain
    ? 'unparsed-statement'
    : first?.kind === 'word' && duckdbEpochLeadingKeywords.has(first.value)
      ? `statement-${first.value}`
      : isDuckdbWordToken(first, 'copy') && isDuckdbWordToken(second, 'from') && isDuckdbWordToken(third, 'database')
        ? 'statement-copy-from-database'
        : isDuckdbSchemaChangeStatement(scan.leading)
          ? 'statement-schema-change'
          : null
}

const getDuckdbTransactionEffect = (tokens: DuckdbStatementToken[]): DuckdbStatementTableWriteEffect | null => {
  const [first, second] = tokens

  return isDuckdbWordToken(first, 'begin')
    || (isDuckdbWordToken(first, 'start') && isDuckdbWordToken(second, 'transaction'))
    ? {kind: 'transactionBegin'}
    : first?.kind === 'word' && duckdbTransactionEndKeywords.has(first.value)
      ? {kind: 'transactionEnd'}
      : null
}

const getDuckdbWriteEffect = (scan: DuckdbStatementScan): DuckdbStatementTableWriteEffect => {
  return scan.writeKeywordCount === 0
    ? {kind: 'none'}
    : {kind: 'write', tables: getDuckdbPreciseWriteTarget(scan) ?? getDuckdbFallbackWriteTables(scan)}
}

const getDuckdbStatementScanEffect = (scan: DuckdbStatementScan): DuckdbStatementTableWriteEffect => {
  settleDuckdbPendingReplace(scan, null)

  const epochReason = getDuckdbEpochStatementReason(scan)

  return epochReason !== null
    ? {kind: 'epoch', reason: epochReason}
    : isDuckdbSearchPathStatement(scan.leading)
      ? {kind: 'searchPath'}
      : (getDuckdbTransactionEffect(scan.leading) ?? getDuckdbWriteEffect(scan))
}

const isDuckdbWhitespaceCode = (code: number) => {
  return code <= 32
}

const isDuckdbWordStartCode = (code: number) => {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === 95 || code >= 128
}

const isDuckdbWordPartCode = (code: number) => {
  return isDuckdbWordStartCode(code) || (code >= 48 && code <= 57) || code === 36
}

const isDuckdbDigitCode = (code: number) => {
  return code >= 48 && code <= 57
}

const getDuckdbWordEnd = (statement: string, start: number) => {
  let index = start

  while (index < statement.length && isDuckdbWordPartCode(statement.charCodeAt(index))) {
    index += 1
  }

  return index
}

const getDuckdbQuotedEnd = (statement: string, start: number, quote: string) => {
  let index = statement.indexOf(quote, start)

  while (index !== -1 && statement[index + 1] === quote) {
    index = statement.indexOf(quote, index + 2)
  }

  return index === -1 ? -1 : index + 1
}

const getDuckdbEscapeStringEnd = (statement: string, start: number) => {
  let index = start

  while (index < statement.length) {
    const character = statement[index]

    if (character === '\\') {
      index += 2
    } else if (character === "'" && statement[index + 1] === "'") {
      index += 2
    } else if (character === "'") {
      return index + 1
    } else {
      index += 1
    }
  }

  return -1
}

const getDuckdbBlockCommentEnd = (statement: string, start: number) => {
  let depth = 1
  let index = start + 2
  let nextOpen = statement.indexOf('/*', index)
  let nextClose = statement.indexOf('*/', index)

  while (depth > 0 && nextClose !== -1) {
    if (nextOpen !== -1 && nextOpen < nextClose) {
      depth += 1
      index = nextOpen + 2
      nextOpen = statement.indexOf('/*', index)
      nextClose = nextClose < index ? statement.indexOf('*/', index) : nextClose
    } else {
      depth -= 1
      index = nextClose + 2
      nextClose = statement.indexOf('*/', index)
      nextOpen = nextOpen !== -1 && nextOpen < index ? statement.indexOf('/*', index) : nextOpen
    }
  }

  return depth === 0 ? index : -1
}

const getDuckdbDollarTagEnd = (statement: string, start: number) => {
  let index = start

  while (index < statement.length && isDuckdbWordPartCode(statement.charCodeAt(index)) && statement[index] !== '$') {
    index += 1
  }

  return index
}

const getDuckdbDollarQuoteEnd = (statement: string, start: number) => {
  const tagEnd = getDuckdbDollarTagEnd(statement, start + 1)
  const tag = statement.slice(start + 1, tagEnd)
  const isDollarQuote = statement[tagEnd] === '$' && (tag === '' || !isDuckdbDigitCode(tag.charCodeAt(0)))
  const delimiter = `$${tag}$`
  const closeIndex = isDollarQuote ? statement.indexOf(delimiter, tagEnd + 1) : -1

  return !isDollarQuote ? null : closeIndex === -1 ? -1 : closeIndex + delimiter.length
}

export const getDuckdbStatementTableWriteEffects = (statement: string): DuckdbStatementTableWriteEffect[] => {
  const effects: DuckdbStatementTableWriteEffect[] = []
  const length = statement.length
  let scan = getEmptyDuckdbStatementScan()
  let index = 0
  let lastWordEnd = -1
  let lastWordValue = ''

  const finishStatement = () => {
    if (scan.leading.length > 0 || scan.uncertain) {
      effects.push(getDuckdbStatementScanEffect(scan))
    }

    scan = getEmptyDuckdbStatementScan()
  }

  const markUncertain = () => {
    scan.uncertain = true
    index = length
  }

  while (index < length) {
    const code = statement.charCodeAt(index)
    const character = statement[index]
    const nextCharacter = statement[index + 1]

    if (isDuckdbWhitespaceCode(code)) {
      index += 1
    } else if (character === '-' && nextCharacter === '-') {
      const lineEnd = statement.indexOf('\n', index + 2)
      index = lineEnd === -1 ? length : lineEnd + 1
    } else if (character === '/' && nextCharacter === '*') {
      const commentEnd = getDuckdbBlockCommentEnd(statement, index)

      if (commentEnd === -1) {
        markUncertain()
      } else {
        index = commentEnd
      }
    } else if (character === "'") {
      const isEscapeString = lastWordEnd === index && lastWordValue === 'e'
      const stringEnd = isEscapeString
        ? getDuckdbEscapeStringEnd(statement, index + 1)
        : getDuckdbQuotedEnd(statement, index + 1, "'")

      if (stringEnd === -1) {
        markUncertain()
      } else {
        recordDuckdbStatementToken(scan, {kind: 'string', value: ''})
        index = stringEnd
      }
    } else if (character === '"') {
      const identifierEnd = getDuckdbQuotedEnd(statement, index + 1, '"')

      if (identifierEnd === -1) {
        markUncertain()
      } else {
        recordDuckdbStatementToken(scan, {
          kind: 'quoted',
          value: statement
            .slice(index + 1, identifierEnd - 1)
            .replaceAll('""', '"')
            .toLowerCase(),
        })
        index = identifierEnd
      }
    } else if (character === '$') {
      const dollarQuoteEnd = getDuckdbDollarQuoteEnd(statement, index)

      if (dollarQuoteEnd === -1) {
        markUncertain()
      } else if (dollarQuoteEnd === null) {
        const parameterEnd = getDuckdbDollarTagEnd(statement, index + 1)
        recordDuckdbStatementToken(scan, {kind: 'number', value: statement.slice(index, parameterEnd)})
        index = parameterEnd
      } else {
        recordDuckdbStatementToken(scan, {kind: 'string', value: ''})
        index = dollarQuoteEnd
      }
    } else if (isDuckdbWordStartCode(code)) {
      const wordEnd = getDuckdbWordEnd(statement, index)
      lastWordValue = statement.slice(index, wordEnd).toLowerCase()
      lastWordEnd = wordEnd
      recordDuckdbStatementToken(scan, {kind: 'word', value: lastWordValue})
      index = wordEnd
    } else if (isDuckdbDigitCode(code)) {
      const numberEnd = getDuckdbWordEnd(statement, index)
      recordDuckdbStatementToken(scan, {kind: 'number', value: ''})
      index = numberEnd
    } else if (character === ';') {
      finishStatement()
      index += 1
    } else {
      recordDuckdbStatementToken(scan, {kind: 'symbol', value: character ?? ''})
      index += 1
    }
  }

  finishStatement()

  return effects
}

const bumpDuckdbTableCounters = (counters: Map<string, number>, tables: Iterable<string>) => {
  for (const table of tables) {
    counters.set(table, (counters.get(table) ?? 0) + 1)
  }
}

const bumpDuckdbTableWriteCounters = (tables: Iterable<string>) => {
  bumpDuckdbTableCounters(duckdbTableWriteTrackerState.counters, tables)
}

export const renewDuckdbTableWriteTrackerEpoch = (reason: string) => {
  duckdbTableWriteTrackerState.epoch = getNewDuckdbTableWriteTrackerEpoch()
  duckdbTableWriteTrackerState.epochReason = reason
}

const getDuckdbOpenTransaction = (connection: object) => {
  return duckdbTableWriteTrackerState.transactionsByConnection.get(connection)
}

const recordDuckdbOpenTransactionWrite = (connection: object, tables: readonly string[]) => {
  const transaction = getDuckdbOpenTransaction(connection)

  tables.map((table) => {
    return transaction?.tables.add(table)
  })
}

const recordDuckdbOpenTransactionEpochChange = (connection: object) => {
  const transaction = getDuckdbOpenTransaction(connection)

  if (transaction !== undefined) {
    transaction.renewEpochAtEnd = true
  }
}

const applyDuckdbTableWriteEffect = (connection: object, effect: DuckdbStatementTableWriteEffect) => {
  if (effect.kind === 'epoch') {
    renewDuckdbTableWriteTrackerEpoch(effect.reason)
    recordDuckdbOpenTransactionEpochChange(connection)
  }

  if (effect.kind === 'searchPath') {
    duckdbTableWriteTrackerState.searchPathChanged = true
    renewDuckdbTableWriteTrackerEpoch('statement-search-path')
    recordDuckdbOpenTransactionEpochChange(connection)
  }

  if (effect.kind === 'write') {
    bumpDuckdbTableWriteCounters(effect.tables)
    recordDuckdbOpenTransactionWrite(connection, effect.tables)
  }
}

const recordDuckdbOpenTransactionEnding = (connection: object) => {
  const transaction = getDuckdbOpenTransaction(connection)

  bumpDuckdbTableWriteCounters(transaction?.tables ?? [])

  if (transaction?.renewEpochAtEnd === true) {
    renewDuckdbTableWriteTrackerEpoch('transaction-with-unattributed-statement-ended')
  }
}

const finishDuckdbOpenTransaction = (connection: object) => {
  recordDuckdbOpenTransactionEnding(connection)
  duckdbTableWriteTrackerState.transactionsByConnection.delete(connection)
}

const applyDuckdbTableWriteEffectAtStart = (connection: object, effect: DuckdbStatementTableWriteEffect) => {
  if (effect.kind === 'transactionEnd') {
    recordDuckdbOpenTransactionEnding(connection)
  }

  applyDuckdbTableWriteEffect(connection, effect)
}

const applyDuckdbTableWriteEffectAtFinish = (connection: object, effect: DuckdbStatementTableWriteEffect) => {
  if (effect.kind === 'transactionBegin' && getDuckdbOpenTransaction(connection) === undefined) {
    duckdbTableWriteTrackerState.transactionsByConnection.set(connection, {renewEpochAtEnd: false, tables: new Set()})
  }

  if (effect.kind === 'transactionEnd') {
    finishDuckdbOpenTransaction(connection)
  }

  applyDuckdbTableWriteEffect(connection, effect)
}

export const beginDuckdbTableWriteTracking = (connection: object, statement: string): DuckdbTrackedStatement => {
  const effects = getDuckdbStatementTableWriteEffects(statement)

  effects.map((effect) => {
    return applyDuckdbTableWriteEffectAtStart(connection, effect)
  })

  return {connection, effects}
}

export const finishDuckdbTableWriteTracking = (trackedStatement: DuckdbTrackedStatement) => {
  trackedStatement.effects.map((effect) => {
    return applyDuckdbTableWriteEffectAtFinish(trackedStatement.connection, effect)
  })
}

const bumpDuckdbExternalTableWriteCounters = (tables: readonly string[]) => {
  bumpDuckdbTableWriteCounters(tables)
  bumpDuckdbTableCounters(duckdbTableWriteTrackerState.externalCounters, tables)
}

export const recordDuckdbTableWriteTrackerExternalWrites = ({
  statements,
  tables,
}: {
  statements: readonly string[]
  tables: readonly string[]
}) => {
  const statementEffects = statements.flatMap((statement) => {
    return getDuckdbStatementTableWriteEffects(statement)
  })

  bumpDuckdbExternalTableWriteCounters(
    tables.map((table) => {
      return table.toLowerCase()
    }),
  )
  statementEffects.map((effect) => {
    return effect.kind === 'write'
      ? bumpDuckdbExternalTableWriteCounters(effect.tables)
      : effect.kind === 'epoch' || effect.kind === 'searchPath'
        ? renewDuckdbTableWriteTrackerEpoch('external-statement')
        : undefined
  })
}

export const recordDuckdbTableWriteTrackerOpen = (identity: string | null) => {
  if (identity === null || identity !== duckdbTableWriteTrackerState.identity) {
    renewDuckdbTableWriteTrackerEpoch(
      identity === null ? 'database-open-without-identity' : 'database-identity-changed',
    )
  }

  duckdbTableWriteTrackerState.identity = identity
  duckdbTableWriteTrackerState.open = true
  duckdbTableWriteTrackerState.searchPathChanged = false
}

export const recordDuckdbTableWriteTrackerClose = () => {
  ;[...duckdbTableWriteTrackerState.transactionsByConnection.keys()].map((connection) => {
    return finishDuckdbOpenTransaction(connection)
  })
  duckdbTableWriteTrackerState.open = false
}

const getDuckdbTableCounterRecord = (counters: Map<string, number>, tables: readonly string[]) => {
  return Object.fromEntries(
    tables.map((table) => {
      const normalizedTable = table.toLowerCase()

      return [normalizedTable, counters.get(normalizedTable) ?? 0]
    }),
  )
}

export const getDuckdbTableWriteTrackerSnapshot = (tables: readonly string[]): DuckdbTableWriteTrackerSnapshot => {
  return {
    available: duckdbTableWriteTrackerState.open && !duckdbTableWriteTrackerState.searchPathChanged,
    counters: getDuckdbTableCounterRecord(duckdbTableWriteTrackerState.counters, tables),
    epoch: duckdbTableWriteTrackerState.epoch,
    epochReason: duckdbTableWriteTrackerState.epochReason,
    externalCounters: getDuckdbTableCounterRecord(duckdbTableWriteTrackerState.externalCounters, tables),
  }
}

export const resetDuckdbTableWriteTrackerForTests = () => {
  duckdbTableWriteTrackerState.counters = new Map()
  duckdbTableWriteTrackerState.externalCounters = new Map()
  duckdbTableWriteTrackerState.identity = null
  duckdbTableWriteTrackerState.open = false
  duckdbTableWriteTrackerState.searchPathChanged = false
  duckdbTableWriteTrackerState.transactionsByConnection = new Map()
  renewDuckdbTableWriteTrackerEpoch('reset-for-tests')
}
