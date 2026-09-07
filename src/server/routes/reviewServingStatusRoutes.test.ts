import {rmSync, writeFileSync} from 'node:fs'

import {afterEach, expect, test} from 'bun:test'
import {Elysia} from 'elysia'

import {reviewServingStatusRoutes} from './reviewServingStatusRoutes.ts'
import {getReviewServingProjectorPauseMarkerPath} from '../utils/reviewServingProjectorPause.ts'
import {runtimeReviewServingStatusPath} from '../utils/runtimeReadyContract.ts'

const markerPath = getReviewServingProjectorPauseMarkerPath('/tmp/forska-review-serving-status-test.duckdb')
const originalDuckdbPath = process.env.DUCKDB_PATH

afterEach(() => {
  rmSync(markerPath, {force: true})
  if (originalDuckdbPath === undefined) {
    delete process.env.DUCKDB_PATH
  } else {
    process.env.DUCKDB_PATH = originalDuckdbPath
  }
})

test('review-serving status remains readable from process state while paused', async () => {
  process.env.DUCKDB_PATH = '/tmp/forska-review-serving-status-test.duckdb'
  writeFileSync(markerPath, 'operator recovery pause')

  const response = await new Elysia()
    .use(reviewServingStatusRoutes)
    .handle(new Request(`http://localhost${runtimeReviewServingStatusPath}`))
  const body = (await response.json()) as {data: {pauseMarker: {exists: boolean}; snapshot: {readable: boolean | null}}}

  expect(response.status).toBe(200)
  expect(body.data.pauseMarker.exists).toBe(true)
  expect(body.data.snapshot.readable).toBeNull()
})
