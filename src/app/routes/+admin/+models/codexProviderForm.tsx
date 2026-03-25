import {Show} from 'solid-js'

import {
  getProviderFormSection,
  ProviderEnabledToggle,
  ProviderReadonlyField,
  ProviderTextField,
} from './providerFormShared.tsx'

export type CodexProviderFormProps = {
  onEnabledChange?: (value: boolean) => void
  onLabelChange: (value: string) => void
  providerLabel: string
  showEnabledToggle?: boolean
  value: {enabled: boolean; label: string}
}

export const CodexProviderForm = (props: CodexProviderFormProps) => {
  return getProviderFormSection(
    <>
      <ProviderReadonlyField label="Provider" value={props.providerLabel} />
      <ProviderTextField label="Connection Label" onInput={props.onLabelChange} type="text" value={props.value.label} />
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
