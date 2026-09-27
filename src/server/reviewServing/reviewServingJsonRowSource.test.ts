import {DuckDBInstance} from '@duckdb/node-api'
import {expect, test} from 'bun:test'

import {getReviewServingJsonRowsSql} from './reviewServingJsonRowSource.ts'

const withConnection = async <T>(
  operation: (connection: Awaited<ReturnType<DuckDBInstance['connect']>>) => Promise<T>,
) => {
  const instance = await DuckDBInstance.create(':memory:')
  const connection = await instance.connect()

  try {
    return await operation(connection)
  } finally {
    connection.closeSync()
    instance.closeSync()
  }
}

const columns = [
  {name: 'article_id', type: 'VARCHAR'},
  {name: 'high_water', type: 'BIGINT'},
  {name: 'rank_numeric', type: 'DOUBLE'},
  {name: 'tombstone', type: 'BOOLEAN'},
  {name: 'updated_at', type: 'TIMESTAMPTZ'},
  {name: 'prompt_ids', type: 'VARCHAR[]'},
  {name: 'payload', type: 'JSON'},
]

test('JSON row source round-trips typed values, quotes and nulls like VALUES literals', async () => {
  await withConnection(async (connection) => {
    const sql = getReviewServingJsonRowsSql({
      columns,
      rows: [
        [
          'it\'s a "quoted" id \\ with backslash',
          12345678901,
          1.5,
          true,
          new Date('2026-09-27T15:13:06.054Z'),
          ['b', 'a'],
          {x: 1},
        ],
        ['second', null, null, false, null, null, null],
      ],
    })
    const reader = await connection.runAndReadAll(`
      SELECT
        article_id,
        high_water,
        rank_numeric,
        tombstone,
        epoch_ms(updated_at) AS updated_at_ms,
        prompt_ids,
        CAST(payload AS VARCHAR) AS payload,
        typeof(high_water) AS high_water_type,
        typeof(updated_at) AS updated_at_type,
        typeof(prompt_ids) AS prompt_ids_type
      FROM (${sql}) AS incoming
      ORDER BY article_id
    `)

    expect(reader.getRowObjectsJson()).toEqual([
      {
        article_id: 'it\'s a "quoted" id \\ with backslash',
        high_water: '12345678901',
        high_water_type: 'BIGINT',
        payload: '{"x":1}',
        prompt_ids: ['b', 'a'],
        prompt_ids_type: 'VARCHAR[]',
        rank_numeric: 1.5,
        tombstone: true,
        updated_at_ms: '1790521986054',
        updated_at_type: 'TIMESTAMP WITH TIME ZONE',
      },
      {
        article_id: 'second',
        high_water: null,
        high_water_type: 'BIGINT',
        payload: null,
        prompt_ids: null,
        prompt_ids_type: 'VARCHAR[]',
        rank_numeric: null,
        tombstone: false,
        updated_at_ms: null,
        updated_at_type: 'TIMESTAMP WITH TIME ZONE',
      },
    ])
  })
})

test('JSON row source yields a typed empty row set without rows', async () => {
  await withConnection(async (connection) => {
    const reader = await connection.runAndReadAll(`
      SELECT COUNT(*)::INTEGER AS n, any_value(typeof(high_water)) AS high_water_type
      FROM (${getReviewServingJsonRowsSql({columns, rows: []})}) AS incoming
    `)

    expect(reader.getRowObjectsJson()).toEqual([{high_water_type: null, n: 0}])
  })
})

test('JSON row source rejects rows whose shape does not match the columns', () => {
  expect(() => {
    return getReviewServingJsonRowsSql({columns, rows: [['only one value']]})
  }).toThrow('row has 1 values for 7 columns')
  expect(() => {
    return getReviewServingJsonRowsSql({columns: [{name: 'id', type: 'VARCHAR'}], rows: [[['a']]]})
  }).toThrow('list value for non-list column id')
})

test('JSON row source feeds INSERT and UPDATE ... FROM with the same coercion as VALUES', async () => {
  await withConnection(async (connection) => {
    await connection.run(`
      CREATE TABLE target (id VARCHAR PRIMARY KEY, n BIGINT, flag BOOLEAN, seen_at TIMESTAMPTZ);
      INSERT INTO target VALUES ('a', 1, FALSE, TIMESTAMPTZ '2026-01-01T00:00:00Z');
    `)
    const incoming = getReviewServingJsonRowsSql({
      columns: [
        {name: 'id', type: 'VARCHAR'},
        {name: 'n', type: 'BIGINT'},
        {name: 'flag', type: 'BOOLEAN'},
        {name: 'seen_at', type: 'TIMESTAMPTZ'},
      ],
      rows: [
        ['a', 2, true, new Date('2026-02-01T00:00:00Z')],
        ['b', 3, false, new Date('2026-03-01T00:00:00Z')],
      ],
    })

    await connection.run(`
      UPDATE target existing SET n = incoming.n, flag = incoming.flag, seen_at = incoming.seen_at
      FROM (${incoming}) AS incoming
      WHERE existing.id = incoming.id
    `)
    await connection.run(`
      INSERT INTO target (id, n, flag, seen_at)
      SELECT id, n, flag, seen_at FROM (${incoming}) AS incoming
      WHERE NOT EXISTS (SELECT 1 FROM target existing WHERE existing.id = incoming.id)
    `)
    const reader = await connection.runAndReadAll(
      `SELECT id, n, flag, epoch_ms(seen_at) AS at_ms FROM target ORDER BY id`,
    )

    expect(reader.getRowObjectsJson()).toEqual([
      {at_ms: '1769904000000', flag: true, id: 'a', n: '2'},
      {at_ms: '1772323200000', flag: false, id: 'b', n: '3'},
    ])
  })
})
