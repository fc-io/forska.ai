import {Show} from 'solid-js'

import {
  getProviderFormSection,
  ProviderApiKeyField,
  ProviderEnabledToggle,
  ProviderReadonlyField,
  ProviderTextField,
} from './providerFormShared.tsx'

export type ApiKeyProviderFormProps = {
  apiKeyLabel?: string
  apiKeyOptional?: boolean
  hasStoredSecret?: boolean
  onApiKeyChange: (value: string) => void
  onBaseURLChange: (value: string) => void
  onClearStoredSecret?: () => void
  onEnabledChange?: (value: boolean) => void
  onLabelChange: (value: string) => void
  providerLabel: string
  secretStatus?: string
  showEnabledToggle?: boolean
  value: {apiKey: string; baseURL: string; enabled: boolean; label: string}
}

export const ApiKeyProviderForm = (props: ApiKeyProviderFormProps) => {
  return getProviderFormSection(
    <>
      <ProviderReadonlyField label="Provider" value={props.providerLabel} />
      <ProviderTextField label="Connection Label" onInput={props.onLabelChange} type="text" value={props.value.label} />
      <ProviderTextField label="Base URL" onInput={props.onBaseURLChange} type="text" value={props.value.baseURL} />
      <ProviderApiKeyField
        hasStoredSecret={props.hasStoredSecret}
        label={props.apiKeyLabel ?? 'API Key'}
        onClearStoredSecret={props.onClearStoredSecret}
        onInput={props.onApiKeyChange}
        optional={props.apiKeyOptional}
        placeholder={props.hasStoredSecret ? 'Enter a new key to replace the stored one' : undefined}
        secretStatus={props.secretStatus}
        value={props.value.apiKey}
      />
      <Show when={props.showEnabledToggle && props.onEnabledChange}>
        <ProviderEnabledToggle
          checked={props.value.enabled}
          onChange={(value) => {
            return props.onEnabledChange?.(value)
          }}
        />
      </Show>
    </>,
  )
}
