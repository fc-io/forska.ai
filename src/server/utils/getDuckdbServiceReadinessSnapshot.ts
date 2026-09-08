import {getEnv} from './env.ts'

export const getDuckdbServiceReadinessSnapshot = () => {
  const state = globalThis.__forskaDuckdbServiceState
  const appendLaneCount =
    state?.duckdbRuntimeConfig?.appendLaneCount ?? Math.max(1, Number(getEnv().DUCKDB_APPEND_LANE_COUNT ?? 2))
  const startupActive = state?.startupPromise != null
  const instanceOpen = state?.duckdbInstance != null
  const controlConnectionOpen = state?.controlConnection != null
  const backgroundConnectionOpen = state?.backgroundConnection != null
  const appendConnectionCount = state?.appendConnections.length ?? 0

  return {
    appendConnectionCount,
    appendLaneCount,
    backgroundConnectionOpen,
    controlConnectionOpen,
    instanceOpen,
    ready:
      !startupActive
      && instanceOpen
      && controlConnectionOpen
      && backgroundConnectionOpen
      && appendConnectionCount === appendLaneCount,
    startupActive,
  }
}
