import {expect, test} from 'bun:test'

import {getNextJudgeWatchdogState, isJudgeWatchdogResponseHealthy} from './getNextJudgeWatchdogState.ts'

test('judge watchdog restarts a dead process immediately', () => {
  expect(
    getNextJudgeWatchdogState({consecutiveFailureCount: 0, healthy: false, processAlive: false, restartThreshold: 3}),
  ).toEqual({consecutiveFailureCount: 1, shouldRestart: true})
})

test('judge watchdog requires consecutive health failures and resets after recovery', () => {
  const firstFailure = getNextJudgeWatchdogState({
    consecutiveFailureCount: 0,
    healthy: false,
    processAlive: true,
    restartThreshold: 3,
  })
  const secondFailure = getNextJudgeWatchdogState({
    consecutiveFailureCount: firstFailure.consecutiveFailureCount,
    healthy: false,
    processAlive: true,
    restartThreshold: 3,
  })
  const thirdFailure = getNextJudgeWatchdogState({
    consecutiveFailureCount: secondFailure.consecutiveFailureCount,
    healthy: false,
    processAlive: true,
    restartThreshold: 3,
  })
  const recovered = getNextJudgeWatchdogState({
    consecutiveFailureCount: secondFailure.consecutiveFailureCount,
    healthy: true,
    processAlive: true,
    restartThreshold: 3,
  })

  expect(firstFailure).toEqual({consecutiveFailureCount: 1, shouldRestart: false})
  expect(secondFailure).toEqual({consecutiveFailureCount: 2, shouldRestart: false})
  expect(thirdFailure).toEqual({consecutiveFailureCount: 3, shouldRestart: true})
  expect(recovered).toEqual({consecutiveFailureCount: 0, shouldRestart: false})
})

test('judge watchdog health accepts a reachable judge worker even when owner-derived readiness is false', () => {
  expect(isJudgeWatchdogResponseHealthy({body: {data: {ready: false, role: 'judge-worker'}}, responseOk: true})).toBe(
    true,
  )
  expect(isJudgeWatchdogResponseHealthy({body: {data: {ready: true, role: 'judge-worker'}}, responseOk: true})).toBe(
    true,
  )
  expect(isJudgeWatchdogResponseHealthy({body: null, responseOk: true})).toBe(false)
  expect(isJudgeWatchdogResponseHealthy({body: {data: {role: 'api'}}, responseOk: true})).toBe(false)
  expect(isJudgeWatchdogResponseHealthy({body: {data: {ready: true, role: 'judge-worker'}}, responseOk: false})).toBe(
    false,
  )
})
