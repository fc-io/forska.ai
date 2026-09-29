import {fileURLToPath} from 'node:url'

import {expect, test} from 'bun:test'

import {canDuckdbStatementDeleteIndexedRows} from './duckdbStatementIndexedRowDeletion.ts'

const canDuckdbStatementDeleteIndexedRowsBeforeLinearRewrite = (statement: string) => {
  return (
    /\b(?:DELETE\s+FROM|MERGE\s+INTO|UPDATE)\b/iu.test(statement)
    || /\bINSERT\s+OR\s+IGNORE\s+INTO\b/iu.test(statement)
    || (/\bINSERT\s+INTO\b/iu.test(statement) && /\bON\s+CONFLICT\b[\s\S]*\bDO\s+UPDATE\b/iu.test(statement))
  )
}

const representativeStatements: ReadonlyArray<readonly [string, boolean]> = [
  [
    "INSERT INTO app.article_import_route (id, article_id) VALUES ('a', 'b') ON CONFLICT(article_id, import_route_id) DO UPDATE SET external_article_id = excluded.external_article_id",
    true,
  ],
  [
    "INSERT INTO app.import_route (id, route) VALUES ('a', '/api/datasources/import/pubmed') ON CONFLICT(route) DO NOTHING",
    false,
  ],
  ['INSERT INTO t SELECT * FROM s ON CONFLICT (id) DO\n  UPDATE SET v = excluded.v', true],
  ['insert into t values (1) on conflict (id) do update set v = 1', true],
  ['INSERT OR IGNORE INTO app.t VALUES (1)', true],
  ['insert   or\n ignore\tinto app.t values (1)', true],
  ['INSERT OR REPLACE INTO app.t VALUES (1)', false],
  ["DELETE FROM app.review_import_article_hot_field WHERE article_id = 'a'", true],
  ['DELETE\nFROM app.t', true],
  ["UPDATE app.data_source SET cursor = 'x' WHERE id = 'y'", true],
  ['MERGE INTO app.t USING s ON t.id = s.id WHEN MATCHED THEN UPDATE SET v = s.v', true],
  ['WITH doomed AS (SELECT id FROM app.t) DELETE FROM app.t WHERE id IN (SELECT id FROM doomed)', true],
  ["INSERT INTO app.article (id, article_summary) VALUES ('a', 'plain abstract')", false],
  ["INSERT INTO app.article (id, article_summary) VALUES ('a', 'effects on conflict resolution')", false],
  [
    "INSERT INTO app.article (id, article_summary) VALUES ('a', 'α ≥ 5: dysregulation on conflict resolution styles')",
    false,
  ],
  ["INSERT INTO app.article (id, article_summary) VALUES ('a', 'an update on conflict resolution')", true],
  ["INSERT INTO t VALUES ('DO UPDATE') ON CONFLICT DO NOTHING", true],
  ["INSERT INTO t VALUES (1) ON CONFLICT (id) DO NOTHING RETURNING 'do update'", true],
  ['INSERT INTO t VALUES (1) ON CONFLICTS DO UPDATE', true],
  ["SELECT * FROM app.article WHERE article_title ILIKE '%updated%'", false],
  ['CREATE TABLE t (updated_at TIMESTAMP)', false],
  ['ALTER TABLE t ADD COLUMN x INT', false],
  ['DELETEFROM t', false],
  ['BEGIN TRANSACTION', false],
  ['COMMIT', false],
  ['SELECT 1', false],
]

test('representative statements classify as before the linear rewrite', () => {
  const results = representativeStatements.map(([statement, expected]) => {
    return {
      expected,
      next: canDuckdbStatementDeleteIndexedRows(statement),
      previous: canDuckdbStatementDeleteIndexedRowsBeforeLinearRewrite(statement),
      statement,
    }
  })

  expect(
    results.filter((result) => {
      return result.next !== result.expected || result.previous !== result.expected
    }),
  ).toEqual([])
})

const fuzzTokens = [
  'ON',
  'on',
  'On',
  'CONFLICT',
  'conflict',
  'DO',
  'do',
  'UPDATE',
  'update',
  'Updated',
  'INSERT',
  'insert',
  'INTO',
  'into',
  'OR',
  'IGNORE',
  'DELETE',
  'FROM',
  'MERGE',
  'x',
  '_',
  '(',
  ')',
  "'",
  ',',
  ' ',
  '  ',
  '\n',
  '\t',
  'α',
  '≥',
  'ſ',
  'K',
]

const getNextFuzzSeed = (seed: number) => {
  return (Math.imul(seed, 1_103_515_245) + 12_345) >>> 0
}

const getFuzzStatement = (seed: number, remainingTokens: number, statement = ''): string => {
  const nextSeed = getNextFuzzSeed(seed)

  return remainingTokens === 0
    ? statement
    : getFuzzStatement(nextSeed, remainingTokens - 1, `${statement}${fuzzTokens[nextSeed % fuzzTokens.length]}`)
}

test('generated keyword soups classify as before the linear rewrite', () => {
  const statements = Array.from({length: 20_000}, (_, index) => {
    return getFuzzStatement(index + 1, 1 + (getNextFuzzSeed(index + 7) % 24))
  })
  const mismatches = statements.filter((statement) => {
    return (
      canDuckdbStatementDeleteIndexedRows(statement)
      !== canDuckdbStatementDeleteIndexedRowsBeforeLinearRewrite(statement)
    )
  })
  const positiveCount = statements.filter(canDuckdbStatementDeleteIndexedRows).length

  expect(mismatches).toEqual([])
  expect(positiveCount).toBeGreaterThan(1_000)
  expect(positiveCount).toBeLessThan(19_000)
})

const adversarialTimingScript = (modulePath: string) => {
  return `
    const {canDuckdbStatementDeleteIndexedRows} = await import(${JSON.stringify(modulePath)})
    const size = 5_000_000
    const sentence = 'Participants (n = 104; α ≥ 0.05) were randomised; outcomes were measured at 12 weeks. '
    const fill = (length) => sentence.repeat(Math.ceil(length / sentence.length)).slice(0, length)
    const articleRow = (index, summary) => "('" + index + "', 'pmid:" + index + "', '" + summary + "')"
    const articleRows = Array.from({length: 2_500}, (_, index) => {
      return articleRow(index, index === 3 ? 'effects of dysregulation on conflict resolution styles' : fill(1_990))
    })
    const cases = [
      ['multi-row article insert with one abstract saying on conflict', 'INSERT INTO app.article (id, article_id, article_summary) VALUES ' + articleRows.join(', '), false],
      ['dense on conflict phrases', "INSERT INTO t VALUES ('α " + 'on conflict '.repeat(size / 12) + "')", false],
      ['upsert with do update after five megabytes of values', "INSERT INTO t (a) VALUES ('" + fill(size) + "') ON CONFLICT (a) DO UPDATE SET a = excluded.a", true],
      ['upsert with do nothing after five megabytes of values', "INSERT INTO t (a) VALUES ('" + fill(size) + "') ON CONFLICT (a) DO NOTHING", false],
      ['long whitespace runs after keywords', "INSERT INTO t VALUES ('α " + ('on' + ' '.repeat(5_000) + 'x delete' + ' '.repeat(5_000) + 'x ').repeat(size / 10_012) + "')", false],
      ['select over five megabytes', "SELECT '" + fill(size) + "'", false],
    ]
    const results = cases.map(([name, statement, expected]) => {
      const startedAtMs = performance.now()
      const result = canDuckdbStatementDeleteIndexedRows(statement)
      return {durationMs: performance.now() - startedAtMs, expected, length: statement.length, name, result}
    })
    console.log(JSON.stringify(results))
  `
}

// A linear pass over 5 MB takes 10-30 ms on a fast core and a few times that on a slow runner. The old regex needed
// hours, so the bound only has to separate those two.
const adversarialStatementMaxMs = 2_000

test('five megabyte adversarial statements classify in linear time', () => {
  const child = globalThis.Bun.spawnSync(
    [
      process.execPath,
      '-e',
      adversarialTimingScript(fileURLToPath(new URL('./duckdbStatementIndexedRowDeletion.ts', import.meta.url))),
    ],
    {cwd: process.cwd(), stderr: 'pipe', stdout: 'pipe', timeout: 30_000},
  )

  expect(
    child.exitCode,
    `classification child did not finish within 30 s (a super-linear regex blocks the thread): ${child.stderr.toString()}`,
  ).toBe(0)

  const results = JSON.parse(child.stdout.toString().trim().split('\n').at(-1) ?? '[]') as Array<{
    durationMs: number
    expected: boolean
    length: number
    name: string
    result: boolean
  }>

  expect(results).toHaveLength(6)
  expect(
    results.filter((result) => {
      return (
        result.length < 4_900_000 || result.result !== result.expected || result.durationMs >= adversarialStatementMaxMs
      )
    }),
  ).toEqual([])
}, 45_000)
