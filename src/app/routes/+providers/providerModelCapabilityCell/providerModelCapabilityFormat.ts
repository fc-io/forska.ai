import {
  type ProviderModelBooleanCapability,
  type ProviderModelCapabilities,
  type ProviderModelCapabilityOverrides,
  type ProviderModelContextWindowCapability,
} from '../../+admin/+models/providerConnectionsClient.ts'

export type ProviderModelCapabilityFormState = {
  imageInput: '' | 'false' | 'true'
  inputTokens: string
  pdfInput: '' | 'false' | 'true'
  totalTokens: string
}

type CapabilityProvenance = Pick<ProviderModelContextWindowCapability, 'source' | 'sourceUrl' | 'verifiedAt'>

const tokenFormatter = new Intl.NumberFormat('en-US')

const formatTokenCount = ({suffix, value}: {suffix: string; value: number | null}): string[] => {
  return value === null ? [] : [`${tokenFormatter.format(value)} ${suffix}`]
}

export const formatProviderModelContextWindow = (contextWindow: ProviderModelContextWindowCapability): string => {
  return [
    ...formatTokenCount({suffix: 'in', value: contextWindow.inputTokens}),
    ...formatTokenCount({suffix: 'total', value: contextWindow.totalTokens}),
  ].join(' / ')
}

export const formatProviderModelBooleanCapability = (capability: ProviderModelBooleanCapability): string => {
  return capability.value ? 'Yes' : 'No'
}

export const getProviderModelCapabilitySourceLabel = (capability: CapabilityProvenance): string => {
  const dateLabel = capability.verifiedAt
    ? `${capability.source === 'user' ? 'set' : 'verified'} ${capability.verifiedAt}`
    : null

  return dateLabel ? `${capability.source} · ${dateLabel}` : capability.source
}

export const hasProviderModelCapabilityOverride = (capabilities: ProviderModelCapabilities | null): boolean => {
  return [capabilities?.contextWindow, capabilities?.supportsImageInput, capabilities?.supportsPdfInput].some(
    (capability) => {
      return capability?.source === 'user'
    },
  )
}

const getUserBooleanFormValue = (
  capability: ProviderModelBooleanCapability | null | undefined,
): ProviderModelCapabilityFormState['imageInput'] => {
  return capability?.source === 'user' ? (String(capability.value) as 'false' | 'true') : ''
}

export const getProviderModelCapabilityFormState = (
  capabilities: ProviderModelCapabilities | null,
): ProviderModelCapabilityFormState => {
  const contextWindow = capabilities?.contextWindow?.source === 'user' ? capabilities.contextWindow : null

  return {
    imageInput: getUserBooleanFormValue(capabilities?.supportsImageInput),
    inputTokens: contextWindow?.inputTokens ? String(contextWindow.inputTokens) : '',
    pdfInput: getUserBooleanFormValue(capabilities?.supportsPdfInput),
    totalTokens: contextWindow?.totalTokens ? String(contextWindow.totalTokens) : '',
  }
}

const getParsedPositiveInteger = (value: string): number | 'invalid' => {
  const parsed = Number(value)

  return Number.isInteger(parsed) && parsed > 0 ? parsed : 'invalid'
}

const getPositiveIntegerInput = (value: string): number | null | 'invalid' => {
  const trimmed = value.trim()

  return trimmed === '' ? null : getParsedPositiveInteger(trimmed)
}

const getBooleanFormValue = (value: ProviderModelCapabilityFormState['imageInput']): boolean | null => {
  return value === '' ? null : value === 'true'
}

const getProviderModelCapabilityFormError = ({
  inputTokens,
  totalTokens,
}: {
  inputTokens: number | null | 'invalid'
  totalTokens: number | null | 'invalid'
}): string | null => {
  const checks: Array<[boolean, string]> = [
    [inputTokens === 'invalid' || totalTokens === 'invalid', 'Token counts must be positive whole numbers.'],
    [inputTokens === null && totalTokens !== null, 'Set input tokens when total tokens are set.'],
    [
      typeof inputTokens === 'number' && typeof totalTokens === 'number' && totalTokens < inputTokens,
      'Total tokens must be at least the input tokens.',
    ],
  ]

  return (
    checks.find(([failed]) => {
      return failed
    })?.[1] ?? null
  )
}

export const getProviderModelCapabilityOverridesFromForm = (
  form: ProviderModelCapabilityFormState,
): {error: string; overrides: null} | {error: null; overrides: ProviderModelCapabilityOverrides} => {
  const inputTokens = getPositiveIntegerInput(form.inputTokens)
  const totalTokens = getPositiveIntegerInput(form.totalTokens)
  const error = getProviderModelCapabilityFormError({inputTokens, totalTokens})

  return error
    ? {error, overrides: null}
    : {
        error: null,
        overrides: {
          contextWindow:
            typeof inputTokens === 'number'
              ? {inputTokens, totalTokens: typeof totalTokens === 'number' ? totalTokens : null}
              : null,
          supportsImageInput: getBooleanFormValue(form.imageInput),
          supportsPdfInput: getBooleanFormValue(form.pdfInput),
        },
      }
}

export const clearedProviderModelCapabilityOverrides: ProviderModelCapabilityOverrides = {
  contextWindow: null,
  supportsImageInput: null,
  supportsPdfInput: null,
}
