import {existsSync, mkdtempSync, rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

import {expect, test} from 'bun:test'

test('readiness diagnostics do not initialize DuckDB or create a database on a cold runtime', () => {
  const directory = mkdtempSync(join(tmpdir(), 'forska-readiness-diagnostics-'))
  const duckdbPath = join(directory, 'unopened.duckdb')

  try {
    const result = globalThis.Bun.spawnSync(
      [
        'bun',
        '-e',
        `
          const {getDuckdbServiceReadinessSnapshot} = await import('./src/server/utils/getDuckdbServiceReadinessSnapshot.ts')
          const snapshot = getDuckdbServiceReadinessSnapshot()
          console.log(JSON.stringify({initialized: globalThis.__forskaDuckdbServiceState !== undefined, snapshot}))
        `,
      ],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          DUCKDB_APPEND_LANE_COUNT: '3',
          DUCKDB_PATH: duckdbPath,
          SERVER_ROLE: 'maintenance-worker',
        },
      },
    )

    expect(result.exitCode).toBe(0)
    expect(JSON.parse(result.stdout.toString())).toEqual({
      initialized: false,
      snapshot: {
        appendConnectionCount: 0,
        appendLaneCount: 3,
        backgroundConnectionOpen: false,
        controlConnectionOpen: false,
        instanceOpen: false,
        ready: false,
        startupActive: false,
      },
    })
    expect(existsSync(duckdbPath)).toBe(false)
    expect(existsSync(`${duckdbPath}.duckdb-owner.lock`)).toBe(false)
  } finally {
    rmSync(directory, {force: true, recursive: true})
  }
})

test('readiness requires finished startup and all configured connections', () => {
  const result = globalThis.Bun.spawnSync(
    [
      'bun',
      '-e',
      `
        const {getDuckdbServiceReadinessSnapshot} = await import('./src/server/utils/getDuckdbServiceReadinessSnapshot.ts')
        const state = {
          duckdbRuntimeConfig: {appendLaneCount: 2},
          startupPromise: Promise.resolve(),
          duckdbInstance: {},
          controlConnection: {},
          backgroundConnection: {},
          appendConnections: [{}, {}],
        }
        globalThis.__forskaDuckdbServiceState = state
        const starting = getDuckdbServiceReadinessSnapshot()
        state.startupPromise = null
        const opened = getDuckdbServiceReadinessSnapshot()
        state.appendConnections.pop()
        const missingAppend = getDuckdbServiceReadinessSnapshot()
        state.appendConnections.push({})
        state.backgroundConnection = null
        const missingBackground = getDuckdbServiceReadinessSnapshot()
        state.backgroundConnection = {}
        state.controlConnection = null
        const missingControl = getDuckdbServiceReadinessSnapshot()
        state.controlConnection = {}
        state.duckdbInstance = null
        const missingInstance = getDuckdbServiceReadinessSnapshot()
        console.log(JSON.stringify({starting, opened, missingAppend, missingBackground, missingControl, missingInstance}))
      `,
    ],
    {cwd: process.cwd(), env: {...process.env, DUCKDB_APPEND_LANE_COUNT: '3', DUCKDB_PATH: ':memory:'}},
  )

  expect(result.exitCode).toBe(0)
  const snapshots = JSON.parse(result.stdout.toString()) as Record<string, unknown>

  expect(snapshots.starting).toMatchObject({appendLaneCount: 2, ready: false, startupActive: true})
  expect(snapshots.opened).toMatchObject({
    appendConnectionCount: 2,
    appendLaneCount: 2,
    ready: true,
    startupActive: false,
  })
  expect(snapshots.missingAppend).toMatchObject({appendConnectionCount: 1, ready: false})
  expect(snapshots.missingBackground).toMatchObject({backgroundConnectionOpen: false, ready: false})
  expect(snapshots.missingControl).toMatchObject({controlConnectionOpen: false, ready: false})
  expect(snapshots.missingInstance).toMatchObject({instanceOpen: false, ready: false})
})
