import {existsSync} from 'node:fs'

import {env} from './env.ts'
import {getDuckdbPath} from './getDuckdbPath.ts'

const reviewServingProjectorPauseMarkerSuffix = '.review-serving-projector-paused'

const getCurrentDuckdbPath = () => {
  return getDuckdbPath({duckdbPath: process.env.DUCKDB_PATH ?? env.DUCKDB_PATH})
}

export const getReviewServingProjectorPauseMarkerPath = (duckdbPath = getCurrentDuckdbPath()) => {
  return `${getDuckdbPath({duckdbPath})}${reviewServingProjectorPauseMarkerSuffix}`
}

export const isReviewServingProjectorPaused = (duckdbPath = getCurrentDuckdbPath()) => {
  const normalizedDuckdbPath = getDuckdbPath({duckdbPath})
  return (
    normalizedDuckdbPath !== ':memory:' && existsSync(getReviewServingProjectorPauseMarkerPath(normalizedDuckdbPath))
  )
}
