import {existsSync, rmSync, statSync, writeFileSync} from 'node:fs'

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

export const getReviewServingProjectorPauseMarkerState = (duckdbPath = getCurrentDuckdbPath()) => {
  const normalizedDuckdbPath = getDuckdbPath({duckdbPath})

  if (normalizedDuckdbPath === ':memory:') {
    return {exists: false as const, markerPath: getReviewServingProjectorPauseMarkerPath(normalizedDuckdbPath)}
  }

  const markerPath = getReviewServingProjectorPauseMarkerPath(normalizedDuckdbPath)

  try {
    const stats = statSync(markerPath)

    return {createdAtMs: stats.birthtimeMs, exists: true as const, markerPath, updatedAtMs: stats.mtimeMs}
  } catch {
    return {exists: false as const, markerPath}
  }
}

export const clearReviewServingProjectorPauseMarker = (duckdbPath = getCurrentDuckdbPath()) => {
  const markerPath = getReviewServingProjectorPauseMarkerPath(duckdbPath)
  rmSync(markerPath, {force: true})
}

export const pauseReviewServingProjector = ({
  duckdbPath = getCurrentDuckdbPath(),
  reason,
}: {
  duckdbPath?: string
  reason: string
}) => {
  const normalizedDuckdbPath = getDuckdbPath({duckdbPath})
  const markerPath = getReviewServingProjectorPauseMarkerPath(normalizedDuckdbPath)

  if (normalizedDuckdbPath === ':memory:') {
    return {markerPath, paused: false as const}
  }

  try {
    writeFileSync(markerPath, `${JSON.stringify({pausedAt: new Date().toISOString(), reason})}\n`, 'utf8')
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)

    return {errorMessage, markerPath, paused: false as const}
  }

  return {markerPath, paused: true as const}
}
