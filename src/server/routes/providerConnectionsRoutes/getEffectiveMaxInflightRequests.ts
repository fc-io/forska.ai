import {getClaudeCodeMaxInflight} from '../../cron/judgmentsJobs/getClaudeCodeMaxInflight.ts'
import {getCodexMaxInflight} from '../../cron/judgmentsJobs/getCodexMaxInflight.ts'
import {getJudgmentsCapacity} from '../../cron/judgmentsJobs/getJudgmentsCapacity.ts'
import {isClaudeCodeProvider, isCodexProvider} from '../../services/providerCatalog.ts'

export const getEffectiveMaxInflightRequests = ({
  maxInflightRequests,
  providerKind,
}: {
  maxInflightRequests: number | null
  providerKind: string
}): number => {
  return (
    maxInflightRequests
    ?? (isCodexProvider(providerKind)
      ? getCodexMaxInflight()
      : isClaudeCodeProvider(providerKind)
        ? getClaudeCodeMaxInflight()
        : getJudgmentsCapacity(1).maxInflight)
  )
}
