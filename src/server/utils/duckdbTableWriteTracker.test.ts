import {beforeEach, expect, test} from 'bun:test'

import {
  beginDuckdbTableWriteTracking,
  finishDuckdbTableWriteTracking,
  getDuckdbStatementTableWriteEffects,
  getDuckdbTableWriteTrackerSnapshot,
  recordDuckdbTableWriteTrackerClose,
  recordDuckdbTableWriteTrackerExternalWrites,
  recordDuckdbTableWriteTrackerOpen,
  resetDuckdbTableWriteTrackerForTests,
} from './duckdbTableWriteTracker.ts'

const trackedTables = ['app.article', 'app.judgment', 'app.project', 'app.prompt', 'app.review_serving_dirty_work']

const getWriteTables = (statement: string) => {
  return getDuckdbStatementTableWriteEffects(statement).flatMap((effect) => {
    return effect.kind === 'write' ? effect.tables : []
  })
}

const getEffectKinds = (statement: string) => {
  return getDuckdbStatementTableWriteEffects(statement).map((effect) => {
    return effect.kind
  })
}

const getCounter = (snapshot: ReturnType<typeof getDuckdbTableWriteTrackerSnapshot>, table: string) => {
  return snapshot.counters[table] ?? Number.NaN
}

const runTrackedStatement = (connection: object, statement: string) => {
  finishDuckdbTableWriteTracking(beginDuckdbTableWriteTracking(connection, statement))
}

beforeEach(() => {
  resetDuckdbTableWriteTrackerForTests()
  recordDuckdbTableWriteTrackerOpen('database-a')
})

test('duckdb table write tracker attributes writes to their app target tables', () => {
  expect(getWriteTables('INSERT INTO app.article (id) VALUES (1)')).toEqual(['app.article'])
  expect(getWriteTables('insert or replace into "APP"."Article" by name select * from app.prompt')).toEqual([
    'app.article',
  ])
  expect(getWriteTables('INSERT OR IGNORE INTO app . article SELECT * FROM app.project')).toEqual(['app.article'])
  expect(getWriteTables("UPDATE app.prompt SET text = replace(text, 'a', 'b') FROM app.project")).toEqual([
    'app.prompt',
  ])
  expect(getWriteTables('DELETE FROM forska.app.judgment USING app.article WHERE TRUE')).toEqual(['app.judgment'])
  expect(
    getWriteTables(
      'INSERT INTO app.judgment (id) SELECT id FROM app.article ON CONFLICT (id) DO UPDATE SET updated_at = now() RETURNING id',
    ),
  ).toEqual(['app.judgment'])
  expect(getWriteTables('CREATE OR REPLACE TABLE app.article_copy AS SELECT * FROM app.article')).toEqual([
    'app.article_copy',
  ])
  expect(getWriteTables('CREATE TEMP TABLE staged_article AS SELECT * FROM app.article')).toEqual([])
  expect(getWriteTables('INSERT INTO staged_article SELECT * FROM app.article')).toEqual([])
  expect(getWriteTables('INSERT INTO app.review_serving_dirty_work SELECT id FROM app.article')).toEqual([
    'app.review_serving_dirty_work',
  ])
  expect(
    getWriteTables('WITH source AS (SELECT * FROM app.article) INSERT INTO app.prompt SELECT * FROM source'),
  ).toEqual(['app.prompt'])
  expect(
    getWriteTables(
      'WITH RECURSIVE changed (id) AS MATERIALIZED (SELECT id FROM app.judgment), other AS (SELECT 1) UPDATE app.review_serving_dirty_work AS work SET claimed = TRUE FROM changed WHERE work.id = changed.id',
    ),
  ).toEqual(['app.review_serving_dirty_work'])
  expect(
    getWriteTables(
      'WITH stale AS (SELECT id FROM app.project) DELETE FROM mart.review_serving_base WHERE id IN (SELECT id FROM stale)',
    ),
  ).toEqual([])
})

test('duckdb table write tracker falls back to every named app table for statements it cannot attribute', () => {
  expect(
    getWriteTables(
      'WITH removed AS (DELETE FROM app.article RETURNING id) INSERT INTO app.prompt SELECT * FROM removed',
    ),
  ).toEqual(['app.article', 'app.prompt'])
  expect(
    getWriteTables('WITH source AS (SELECT * FROM app.article) SELECT * FROM source; DROP TABLE app.prompt'),
  ).toEqual(['app.prompt'])
  expect(
    getWriteTables('MERGE INTO app.article USING app.prompt ON TRUE WHEN MATCHED THEN UPDATE SET id = id'),
  ).toEqual(['app.article', 'app.prompt'])
  expect(getWriteTables('ALTER TABLE app.article_repair RENAME TO article')).toEqual([
    'app.article_repair',
    'app.article',
  ])
  expect(getWriteTables('DROP TABLE IF EXISTS app.article')).toEqual(['app.article'])
  expect(getWriteTables("COPY app.article FROM 'articles.csv'")).toEqual(['app.article'])
  expect(getWriteTables('TRUNCATE app.judgment')).toEqual(['app.judgment'])
  expect(getWriteTables('EXPLAIN ANALYZE DELETE FROM app.judgment')).toEqual(['app.judgment'])
  expect(getWriteTables('UPDATE app.prompt SET id = id; DELETE FROM app.article')).toEqual([
    'app.prompt',
    'app.article',
  ])
  expect(
    getWriteTables('INSERT INTO app.prompt SELECT * FROM app.article WHERE x IN (DELETE FROM app.project)'),
  ).toEqual(['app.prompt', 'app.article', 'app.project'])
})

test('duckdb table write tracker ignores literals, comments, and read-only statements', () => {
  expect(getEffectKinds("SELECT * FROM app.article WHERE note = 'insert into app.article; drop table x'")).toEqual([
    'none',
  ])
  expect(getEffectKinds("SELECT replace(title, 'a', 'b'), updated_at FROM app.article")).toEqual(['none'])
  expect(getEffectKinds('SELECT 1 /* DELETE FROM app.article */')).toEqual(['none'])
  expect(getEffectKinds("SELECT $$it's DELETE FROM app.article$$, $tag$ UPDATE app.article $tag$")).toEqual(['none'])
  expect(getEffectKinds("SELECT E'it\\'s INSERT INTO app.article' AS value")).toEqual(['none'])
  expect(
    getWriteTables("INSERT INTO app.review_serving_dirty_work (scope) VALUES ('article:all'), ('app.article')"),
  ).toEqual(['app.review_serving_dirty_work'])
  expect(getWriteTables('INSERT INTO "it\'s" SELECT * FROM app.article')).toEqual([])
  expect(getEffectKinds('CHECKPOINT')).toEqual(['none'])
})

test('duckdb table write tracker classifies transaction, epoch, and search-path statements', () => {
  expect(getEffectKinds('BEGIN TRANSACTION')).toEqual(['transactionBegin'])
  expect(getEffectKinds('START TRANSACTION')).toEqual(['transactionBegin'])
  expect(getEffectKinds('COMMIT')).toEqual(['transactionEnd'])
  expect(getEffectKinds('ROLLBACK')).toEqual(['transactionEnd'])
  expect(getEffectKinds('END')).toEqual(['transactionEnd'])
  expect(getEffectKinds('ABORT')).toEqual(['transactionEnd'])
  expect(getEffectKinds("ATTACH 'other.duckdb' AS other")).toEqual(['epoch'])
  expect(getEffectKinds('DETACH other')).toEqual(['epoch'])
  expect(getEffectKinds("IMPORT DATABASE 'backup'")).toEqual(['epoch'])
  expect(getEffectKinds('COPY FROM DATABASE other TO main')).toEqual(['epoch'])
  expect(getEffectKinds('DROP SCHEMA app CASCADE')).toEqual(['epoch'])
  expect(getEffectKinds('ALTER SCHEMA app RENAME TO old_app')).toEqual(['epoch'])
  expect(getEffectKinds('CREATE OR REPLACE SCHEMA app')).toEqual(['epoch'])
  expect(getEffectKinds('EXECUTE prepared_delete')).toEqual(['epoch'])
  expect(getEffectKinds('CALL some_procedure()')).toEqual(['epoch'])
  expect(getEffectKinds("SELECT 'unterminated")).toEqual(['epoch'])
  expect(getEffectKinds('USE app')).toEqual(['searchPath'])
  expect(getEffectKinds("SET search_path = 'app'")).toEqual(['searchPath'])
  expect(getEffectKinds("SET SESSION schema = 'app'")).toEqual(['searchPath'])
  expect(getEffectKinds('RESET search_path')).toEqual(['searchPath'])
  expect(getEffectKinds("SET memory_limit = '1GB'")).toEqual(['none'])
})

test('duckdb table write tracker bumps written tables at statement start and finish', () => {
  const connection = {}
  const before = getDuckdbTableWriteTrackerSnapshot(trackedTables)
  const tracked = beginDuckdbTableWriteTracking(connection, 'UPDATE app.article SET title = title')
  const during = getDuckdbTableWriteTrackerSnapshot(trackedTables)

  finishDuckdbTableWriteTracking(tracked)

  const after = getDuckdbTableWriteTrackerSnapshot(trackedTables)

  runTrackedStatement(connection, "SELECT * FROM app.article WHERE scope = 'article:all'")
  runTrackedStatement(connection, 'INSERT INTO app.review_serving_dirty_work SELECT id FROM app.article')

  const afterUnrelated = getDuckdbTableWriteTrackerSnapshot(trackedTables)

  expect(before.available).toBe(true)
  expect(getCounter(during, 'app.article')).toBe(getCounter(before, 'app.article') + 1)
  expect(getCounter(after, 'app.article')).toBe(getCounter(during, 'app.article') + 1)
  expect(getCounter(afterUnrelated, 'app.article')).toBe(getCounter(after, 'app.article'))
  expect(getCounter(afterUnrelated, 'app.review_serving_dirty_work')).toBe(2)
  expect(afterUnrelated.epoch).toBe(before.epoch)
})

test('duckdb table write tracker bumps transaction tables again when the transaction ends', () => {
  const connection = {}
  const otherConnection = {}

  runTrackedStatement(connection, 'BEGIN TRANSACTION')
  runTrackedStatement(connection, 'INSERT INTO app.article (id) VALUES (1)')

  const insideTransaction = getDuckdbTableWriteTrackerSnapshot(trackedTables)

  runTrackedStatement(otherConnection, 'COMMIT')

  const afterOtherConnectionCommit = getDuckdbTableWriteTrackerSnapshot(trackedTables)

  runTrackedStatement(connection, 'COMMIT')

  const afterCommit = getDuckdbTableWriteTrackerSnapshot(trackedTables)

  runTrackedStatement(connection, 'BEGIN')
  runTrackedStatement(connection, 'DELETE FROM app.prompt')

  const insideRolledBackTransaction = getDuckdbTableWriteTrackerSnapshot(trackedTables)

  runTrackedStatement(connection, 'ROLLBACK')

  const afterRollback = getDuckdbTableWriteTrackerSnapshot(trackedTables)

  runTrackedStatement(connection, 'BEGIN')
  runTrackedStatement(connection, 'UPDATE app.project SET name = name')

  const insideClosedTransaction = getDuckdbTableWriteTrackerSnapshot(trackedTables)

  recordDuckdbTableWriteTrackerClose()

  const afterClose = getDuckdbTableWriteTrackerSnapshot(trackedTables)

  expect(afterOtherConnectionCommit.counters).toEqual(insideTransaction.counters)
  expect(getCounter(afterCommit, 'app.article')).toBe(getCounter(insideTransaction, 'app.article') + 2)
  expect(getCounter(afterRollback, 'app.prompt')).toBe(getCounter(insideRolledBackTransaction, 'app.prompt') + 2)
  expect(getCounter(afterClose, 'app.project')).toBe(getCounter(insideClosedTransaction, 'app.project') + 1)
  expect(afterClose.available).toBe(false)
})

test('duckdb table write tracker bumps transaction tables when COMMIT starts, before its data becomes visible', () => {
  const connection = {}

  runTrackedStatement(connection, 'BEGIN')
  runTrackedStatement(connection, "INSERT INTO app.judgment (id) VALUES ('j')")

  const afterInsert = getDuckdbTableWriteTrackerSnapshot(trackedTables)
  const commit = beginDuckdbTableWriteTracking(connection, 'COMMIT')
  const duringCommit = getDuckdbTableWriteTrackerSnapshot(trackedTables)

  finishDuckdbTableWriteTracking(commit)

  const afterCommit = getDuckdbTableWriteTrackerSnapshot(trackedTables)

  runTrackedStatement(connection, 'BEGIN')
  runTrackedStatement(connection, 'EXECUTE prepared_insert')

  const afterExecute = getDuckdbTableWriteTrackerSnapshot(trackedTables)
  const opaqueCommit = beginDuckdbTableWriteTracking(connection, 'COMMIT')
  const duringOpaqueCommit = getDuckdbTableWriteTrackerSnapshot(trackedTables)

  finishDuckdbTableWriteTracking(opaqueCommit)

  expect(getCounter(duringCommit, 'app.judgment')).toBe(getCounter(afterInsert, 'app.judgment') + 1)
  expect(getCounter(afterCommit, 'app.judgment')).toBe(getCounter(duringCommit, 'app.judgment') + 1)
  expect(duringOpaqueCommit.epoch).not.toBe(afterExecute.epoch)
  expect(getDuckdbTableWriteTrackerSnapshot(trackedTables).epoch).not.toBe(duringOpaqueCommit.epoch)
})

test('duckdb table write tracker renews the epoch for unattributable statements and identity changes', () => {
  const connection = {}
  const initial = getDuckdbTableWriteTrackerSnapshot(trackedTables)

  recordDuckdbTableWriteTrackerClose()
  recordDuckdbTableWriteTrackerOpen('database-a')

  const reopened = getDuckdbTableWriteTrackerSnapshot(trackedTables)

  runTrackedStatement(connection, "ATTACH 'other.duckdb' AS other")

  const afterAttach = getDuckdbTableWriteTrackerSnapshot(trackedTables)

  recordDuckdbTableWriteTrackerClose()
  recordDuckdbTableWriteTrackerOpen('database-b')

  const afterIdentityChange = getDuckdbTableWriteTrackerSnapshot(trackedTables)

  recordDuckdbTableWriteTrackerClose()
  recordDuckdbTableWriteTrackerOpen(null)

  const afterUnknownIdentity = getDuckdbTableWriteTrackerSnapshot(trackedTables)

  runTrackedStatement(connection, 'USE app')

  const afterUse = getDuckdbTableWriteTrackerSnapshot(trackedTables)

  recordDuckdbTableWriteTrackerClose()
  recordDuckdbTableWriteTrackerOpen(null)

  const afterReopenFromUse = getDuckdbTableWriteTrackerSnapshot(trackedTables)

  expect(reopened.epoch).toBe(initial.epoch)
  expect(reopened.available).toBe(true)
  expect(afterAttach.epoch).not.toBe(reopened.epoch)
  expect(afterIdentityChange.epoch).not.toBe(afterAttach.epoch)
  expect(afterUnknownIdentity.epoch).not.toBe(afterIdentityChange.epoch)
  expect(afterUse.epoch).not.toBe(afterUnknownIdentity.epoch)
  expect(afterUse.available).toBe(false)
  expect(afterReopenFromUse.available).toBe(true)
  expect(afterReopenFromUse.epoch).not.toBe(afterUse.epoch)
})

test('duckdb table write tracker records external startup-probe writes', () => {
  const before = getDuckdbTableWriteTrackerSnapshot(trackedTables)

  recordDuckdbTableWriteTrackerExternalWrites({
    statements: ['UPDATE app.judgment SET id = id WHERE FALSE'],
    tables: ['APP.REVIEW_SERVING_DIRTY_WORK'],
  })

  const after = getDuckdbTableWriteTrackerSnapshot(trackedTables)

  expect(getCounter(after, 'app.judgment')).toBe(getCounter(before, 'app.judgment') + 1)
  expect(getCounter(after, 'app.review_serving_dirty_work')).toBe(
    getCounter(before, 'app.review_serving_dirty_work') + 1,
  )
  expect(after.epoch).toBe(before.epoch)
  expect(after.externalCounters['app.judgment']).toBe((before.externalCounters['app.judgment'] ?? 0) + 1)
  expect(after.externalCounters['app.review_serving_dirty_work']).toBe(
    (before.externalCounters['app.review_serving_dirty_work'] ?? 0) + 1,
  )
  expect(after.externalCounters['app.article']).toBe(before.externalCounters['app.article'])
})

test('duckdb table write tracker renews the epoch again when a transaction with an opaque statement ends', () => {
  const connection = {}
  const runOpaqueTransaction = (endStatement: string | null) => {
    runTrackedStatement(connection, "PREPARE ins AS INSERT INTO app.judgment (id) VALUES ('j')")
    runTrackedStatement(connection, 'BEGIN')
    runTrackedStatement(connection, 'EXECUTE ins')

    const beforeEnd = getDuckdbTableWriteTrackerSnapshot(trackedTables)

    if (endStatement === null) {
      recordDuckdbTableWriteTrackerClose()
      recordDuckdbTableWriteTrackerOpen('database-a')
    } else {
      runTrackedStatement(connection, endStatement)
    }

    return {afterEnd: getDuckdbTableWriteTrackerSnapshot(trackedTables), beforeEnd}
  }
  const committed = runOpaqueTransaction('COMMIT')
  const rolledBack = runOpaqueTransaction('ROLLBACK')
  const closed = runOpaqueTransaction(null)

  runTrackedStatement(connection, 'BEGIN')
  runTrackedStatement(connection, 'INSERT INTO app.judgment (id) VALUES (1)')

  const beforePlainCommit = getDuckdbTableWriteTrackerSnapshot(trackedTables)

  runTrackedStatement(connection, 'COMMIT')

  expect(committed.afterEnd.epoch).not.toBe(committed.beforeEnd.epoch)
  expect(rolledBack.afterEnd.epoch).not.toBe(rolledBack.beforeEnd.epoch)
  expect(closed.afterEnd.epoch).not.toBe(closed.beforeEnd.epoch)
  expect(getDuckdbTableWriteTrackerSnapshot(trackedTables).epoch).toBe(beforePlainCommit.epoch)
})

test('duckdb table write tracker recognises every search-path setting form', () => {
  const statements = [
    'USE app',
    "SET search_path = 'app'",
    "SET search_path TO 'app'",
    'SET "schema" = \'app\'',
    'SET "SEARCH_PATH" TO \'app\'',
    "SET SESSION search_path = 'app'",
    "SET GLOBAL schema = 'app'",
    'SET LOCAL search_path TO app',
    'SET SESSION "schema" TO \'app\'',
    "PRAGMA search_path='app'",
    "PRAGMA search_path = 'app'",
    'PRAGMA "schema"(\'app\')',
    'RESET search_path',
    'RESET SESSION schema',
  ]

  expect(
    statements.map((statement) => {
      return getEffectKinds(statement)
    }),
  ).toEqual(
    statements.map(() => {
      return ['searchPath']
    }),
  )
  expect(getEffectKinds("SET threads = 'schema'")).toEqual(['none'])
  expect(getEffectKinds('PRAGMA enable_profiling')).toEqual(['none'])

  runTrackedStatement({}, 'SET "schema" = \'app\'')
  runTrackedStatement({}, "UPDATE article SET article_title = 'unqualified'")

  expect(getDuckdbTableWriteTrackerSnapshot(trackedTables).available).toBe(false)
})

test('duckdb table write tracker follows nested block comments', () => {
  expect(getWriteTables("/* outer /* inner */ BEGIN */ INSERT INTO app.judgment (id) VALUES ('j')")).toEqual([
    'app.judgment',
  ])
  expect(getEffectKinds("/* outer /* inner */ BEGIN */ INSERT INTO app.judgment (id) VALUES ('j')")).toEqual(['write'])
  expect(getEffectKinds("/* a /* b */ c */ /*/ d */ INSERT INTO app.judgment (id) VALUES ('j')")).toEqual(['write'])
  expect(getEffectKinds("/* outer /* inner */ INSERT INTO app.judgment (id) VALUES ('j')")).toEqual(['epoch'])
  expect(getEffectKinds('/* /* */ */ COMMIT')).toEqual(['transactionEnd'])
  expect(getEffectKinds("SELECT '/*' AS opener, 1")).toEqual(['none'])
})

test('duckdb table write tracker scans deeply nested comments in linear time', () => {
  const depth = 2_000_000
  const statement = `${'/*'.repeat(depth)}${' x '}${'*/'.repeat(depth)} UPDATE app.prompt SET id = id`
  const startedAt = performance.now()
  const tables = getWriteTables(statement)
  const durationMs = performance.now() - startedAt

  expect(tables).toEqual(['app.prompt'])
  expect(durationMs).toBeLessThan(2_000)
})

test('duckdb table write tracker scans a 20 MB statement quickly', () => {
  const rowLiteral = "('article-id', 'a title with insert into app.prompt and it''s update', 12345, 'article:all')"
  const valueCount = Math.ceil((20 * 1024 * 1024) / (rowLiteral.length + 2))
  const statement = `INSERT INTO app.article (id, title, year, scope) VALUES ${Array.from({length: valueCount}, () => {
    return rowLiteral
  }).join(', ')}`
  const startedAt = performance.now()
  const tables = getWriteTables(statement)
  const durationMs = performance.now() - startedAt

  expect(statement.length).toBeGreaterThan(20 * 1024 * 1024)
  expect(tables).toEqual(['app.article'])
  expect(durationMs).toBeLessThan(2_000)
})
