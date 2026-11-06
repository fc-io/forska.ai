import {claudeCodeFailureCodes} from './claudeCodeFailureCodes.ts'

export const anthropicRefusalEmptyResponseFailureCode = 'anthropic_refusal_empty_response'

export const providerContentRefusalFailureCodes: string[] = [
  anthropicRefusalEmptyResponseFailureCode,
  claudeCodeFailureCodes.contentRefusal,
]

export const isProviderContentRefusalFailureCode = (failureCode: string | null | undefined): boolean => {
  return providerContentRefusalFailureCodes.includes(failureCode ?? '')
}
