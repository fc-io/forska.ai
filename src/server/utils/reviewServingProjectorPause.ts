import {existsSync} from 'node:fs'

import {env} from './env.ts'

const reviewServingProjectorPauseMarkerSuffix = '.review-serving-projector-paused'

export const getReviewServingProjectorPauseMarkerPath = (duckdbPath = env.DUCKDB_PATH) => {
  return `${duckdbPath}${reviewServingProjectorPauseMarkerSuffix}`
}

export const isReviewServingProjectorPaused = (duckdbPath = env.DUCKDB_PATH) => {
  return duckdbPath !== ':memory:' && existsSync(getReviewServingProjectorPauseMarkerPath(duckdbPath))
}
