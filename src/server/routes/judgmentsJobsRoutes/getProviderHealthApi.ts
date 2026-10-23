import {
  type JudgmentJobProviderHealth,
  type JudgmentJobProviderHealthApi,
  toJudgmentJobProviderHealthApi,
} from '../../services/judgmentJobProviderHealthService.ts'

export const getProviderHealthApi = ({
  jobStatus,
  providerHealth,
}: {
  jobStatus: string
  providerHealth: JudgmentJobProviderHealth | null | undefined
}): JudgmentJobProviderHealthApi | null => {
  return providerHealth ? toJudgmentJobProviderHealthApi(providerHealth, {jobStatus}) : null
}
