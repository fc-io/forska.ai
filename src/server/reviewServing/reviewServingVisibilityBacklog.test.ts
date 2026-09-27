import {DuckDBInstance} from '@duckdb/node-api'
import {afterEach, expect, test} from 'bun:test'

import {duckdbEngineCompatibilityOptions} from '../utils/duckdbEngineContract.ts'
import {
  getReviewServingVisibilityBacklogProjects,
  reportReviewServingVisibilityBacklog,
  resetReviewServingVisibilityBacklogReportForTests,
} from './reviewServingVisibilityBacklog.ts'

const createClaimStateDatabase = async () => {
  const instance = await DuckDBInstance.create(':memory:', {...duckdbEngineCompatibilityOptions, memory_limit: '256MB'})
  const connection = await instance.connect()
  const statements: string[] = []

  await connection.run('CREATE SCHEMA app')
  await connection.run(`
    CREATE TABLE app.review_serving_dirty_work_claim_state (
      dirty_work_id VARCHAR PRIMARY KEY,
      project_id VARCHAR NOT NULL,
      projection_component VARCHAR NOT NULL,
      status VARCHAR NOT NULL,
      lifecycle_reason VARCHAR,
      updated_at TIMESTAMPTZ NOT NULL
    )
  `)

  return {
    close: () => {
      connection.closeSync()
      instance.closeSync()
    },
    database: {
      queryJson: async <T>(statement: string) => {
        statements.push(statement)

        return (await connection.runAndReadAll(statement)).getRowObjectsJson() as T[]
      },
    },
    insert: async (rows: ReadonlyArray<[string, string, string, string, string | null, string]>) => {
      await connection.run(`
        INSERT INTO app.review_serving_dirty_work_claim_state VALUES ${rows
          .map((row) => {
            return `(${row
              .map((value, index) => {
                return value === null ? 'NULL' : index === 5 ? `TIMESTAMPTZ '${value}'` : `'${value}'`
              })
              .join(', ')})`
          })
          .join(', ')}
      `)
    },
    statements,
  }
}

afterEach(() => {
  resetReviewServingVisibilityBacklogReportForTests()
})

test('visibility backlog reports pending and newly projected visibility work per project, largest backlog first', async () => {
  const {close, database, insert} = await createClaimStateDatabase()

  try {
    await insert([
      ['a-scope-1', 'project-a', 'projectScope', 'pending', null, '2026-09-27T08:00:00Z'],
      ['a-scope-2', 'project-a', 'projectScope', 'running', null, '2026-09-27T08:00:00Z'],
      ['a-llm-1', 'project-a', 'llmStatus', 'blocked_by_rebuild', null, '2026-09-27T08:00:00Z'],
      ['a-si-1', 'project-a', 'selectedImport', 'completed', 'projected', '2026-09-27T08:00:30Z'],
      ['a-si-2', 'project-a', 'selectedImport', 'completed', 'projected', '2026-09-27T07:58:00Z'],
      ['a-queue-1', 'project-a', 'queue', 'completed', 'covered_by_rebuild', '2026-09-27T08:00:30Z'],
      ['a-summary-1', 'project-a', 'summary', 'pending', null, '2026-09-27T08:00:00Z'],
      ['b-queue-1', 'project-b', 'queue', 'failed', null, '2026-09-27T08:00:00Z'],
      ['c-scope-1', 'project-c', 'projectScope', 'completed', 'projected', '2026-09-27T08:00:40Z'],
    ])

    const projects = await reportReviewServingVisibilityBacklog({database, nowMs: Date.parse('2026-09-27T08:01:00Z')})

    expect(projects).toEqual([
      {
        madeVisibleCount: 1,
        pendingCounts: {humanStatus: 0, llmStatus: 1, projectScope: 2, queue: 0, selectedImport: 0},
        pendingTotal: 3,
        projectId: 'project-a',
        projectedCounts: {humanStatus: 0, llmStatus: 0, projectScope: 0, queue: 0, selectedImport: 1},
      },
      {
        madeVisibleCount: 0,
        pendingCounts: {humanStatus: 0, llmStatus: 0, projectScope: 0, queue: 1, selectedImport: 0},
        pendingTotal: 1,
        projectId: 'project-b',
        projectedCounts: {humanStatus: 0, llmStatus: 0, projectScope: 0, queue: 0, selectedImport: 0},
      },
    ])
  } finally {
    close()
  }
})

test('visibility backlog reports at most once a minute and counts projections since the previous report', async () => {
  const {close, database, insert, statements} = await createClaimStateDatabase()
  const startMs = Date.parse('2026-09-27T08:00:00Z')

  try {
    await insert([['a-scope-1', 'project-a', 'projectScope', 'pending', null, '2026-09-27T07:00:00Z']])

    expect(await reportReviewServingVisibilityBacklog({database, nowMs: startMs})).toHaveLength(1)
    expect(await reportReviewServingVisibilityBacklog({database, nowMs: startMs + 59_999})).toBeNull()

    await insert([['a-si-1', 'project-a', 'selectedImport', 'completed', 'projected', '2026-09-27T08:00:30Z']])

    expect(await reportReviewServingVisibilityBacklog({database, nowMs: startMs + 60_000})).toMatchObject([
      {madeVisibleCount: 1, projectId: 'project-a'},
    ])
    expect(statements).toHaveLength(2)
    expect(statements[1]).toContain("TIMESTAMPTZ '2026-09-27T08:00:00.000Z'")
  } finally {
    close()
  }
})

test('visibility backlog keeps the top projects by pending visibility work', () => {
  const rows = ['project-a', 'project-b', 'project-c'].flatMap((projectId, index) => {
    return [{component: 'queue' as const, pendingCount: String(index + 1), projectId, projectedCount: '0'}]
  })

  expect(
    getReviewServingVisibilityBacklogProjects(rows, 2).map((project) => {
      return [project.projectId, project.pendingTotal]
    }),
  ).toEqual([
    ['project-c', 3],
    ['project-b', 2],
  ])
})
