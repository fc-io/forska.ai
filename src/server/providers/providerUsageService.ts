import {type ProviderKind} from '../services/providerCatalog.ts'
import {getProviderRegistryEntry} from './providerRegistry.ts'
import {type ProviderUsageSnapshot} from './providerTypes.ts'

export const getEmptyProviderUsageSnapshot = (): ProviderUsageSnapshot => {
  return {completionTokens: 0, promptTokens: 0, totalTokens: 0}
}

const getNormalizedProviderUsageSnapshot = (
  usage: Partial<ProviderUsageSnapshot> | null | undefined,
): ProviderUsageSnapshot => {
  return {
    completionTokens: usage?.completionTokens ?? 0,
    promptTokens: usage?.promptTokens ?? 0,
    totalTokens: usage?.totalTokens ?? 0,
  }
}

export const parseProviderUsageSnapshot = ({
  providerKind,
  usage,
}: {
  providerKind: ProviderKind
  usage: Partial<ProviderUsageSnapshot> | null | undefined
}): ProviderUsageSnapshot => {
  const definition = getProviderRegistryEntry(providerKind)
  const normalizedUsage = getNormalizedProviderUsageSnapshot(usage)

  return definition?.parseUsage ? definition.parseUsage(normalizedUsage) : normalizedUsage
}

export const getProviderUsageService = () => {
  return {empty: getEmptyProviderUsageSnapshot, parse: parseProviderUsageSnapshot}
}
