export type JudgeWatchdogState = {consecutiveFailureCount: number; shouldRestart: boolean}
export type JudgeRuntimeReadyBody = {data?: {ready?: unknown; role?: unknown}}

export const isJudgeWatchdogResponseHealthy = ({
  body,
  responseOk,
}: {
  body: JudgeRuntimeReadyBody | null
  responseOk: boolean
}) => {
  return responseOk && body?.data?.role === 'judge-worker'
}

export const getNextJudgeWatchdogState = ({
  consecutiveFailureCount,
  healthy,
  processAlive,
  restartThreshold,
}: {
  consecutiveFailureCount: number
  healthy: boolean
  processAlive: boolean
  restartThreshold: number
}): JudgeWatchdogState => {
  const nextFailureCount = processAlive && healthy ? 0 : consecutiveFailureCount + 1

  return {
    consecutiveFailureCount: nextFailureCount,
    shouldRestart: !processAlive || nextFailureCount >= restartThreshold,
  }
}
