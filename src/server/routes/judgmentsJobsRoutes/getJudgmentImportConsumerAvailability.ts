import {getDuckdbOwnerConnectionsOverview} from '../../utils/duckdbOwnerConnections.ts'
import {shouldCurrentServerRunJudgingLoops} from '../../utils/serverRuntimeRole.ts'
import type {JudgmentJobImportConsumerAvailability} from './judgmentJobHealthTypes.ts'

export const getJudgmentImportConsumerAvailability = async (): Promise<JudgmentJobImportConsumerAvailability> => {
  const registry = (await getDuckdbOwnerConnectionsOverview()).registry
  const judging = registry.capabilities.find((capability) => {
    return capability.capability === 'judging'
  })
  const localJudgingConsumerCount = shouldCurrentServerRunJudgingLoops() ? 1 : 0
  const eligibleConsumerCount = Math.max(judging?.eligibleConsumerCount ?? 0, localJudgingConsumerCount)
  const freshConsumerCount = Math.max(judging?.freshConsumerCount ?? 0, localJudgingConsumerCount)
  const registeredConsumerCount = Math.max(judging?.registeredConsumerCount ?? 0, localJudgingConsumerCount)

  return {
    eligibleConsumerCount,
    eligibleConsumerPresent: eligibleConsumerCount > 0,
    freshConsumerCount,
    freshConsumerPresent: freshConsumerCount > 0,
    registeredConsumerCount,
    requiredConsumerRole: 'judge-worker',
    staleConsumerCount: judging?.staleConsumerCount ?? 0,
  }
}
