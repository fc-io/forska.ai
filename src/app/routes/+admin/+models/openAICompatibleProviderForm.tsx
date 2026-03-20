import {Show} from 'solid-js'

import {
  getProviderFormSection,
  ProviderApiKeyField,
  ProviderEnabledToggle,
  ProviderReadonlyField,
  ProviderTextField,
} from './providerFormShared.tsx'

export type OpenAICompatibleProviderFormProps = {
  apiKeyLabel?: string
  apiKeyOptional?: boolean
  hasStoredSecret?: boolean
  onApiKeyChange: (value: string) => void
  onBaseURLChange: (value: string) => void
  onClearStoredSecret?: () => void
  onEnabledChange?: (value: boolean) => void
  onLabelChange: (value: string) => void
  onWorkerUrlModeChange?: (value: 'manual' | 'runtime') => void
  onWorkerUrlsChange: (value: string) => void
  providerLabel: string
  runtimeWorkerUrls?: string[]
  secretStatus?: string
  showApiKeyField?: boolean
  showEnabledToggle?: boolean
  supportsRuntimeWorkerUrls?: boolean
  supportsWorkerUrls?: boolean
  value: {
    apiKey: string
    baseURL: string
    enabled: boolean
    label: string
    manualWorkerUrls: string
    workerUrlMode: 'manual' | 'runtime'
  }
}

export const OpenAICompatibleProviderForm = (props: OpenAICompatibleProviderFormProps) => {
  return getProviderFormSection(
    <>
      <ProviderReadonlyField label="Provider" value={props.providerLabel} />
      <ProviderTextField label="Connection Label" onInput={props.onLabelChange} type="text" value={props.value.label} />
      <ProviderTextField label="Base URL" onInput={props.onBaseURLChange} type="text" value={props.value.baseURL} />
      <Show when={props.supportsRuntimeWorkerUrls && props.onWorkerUrlModeChange}>
        <div>
          <label class="mb-2 block text-sm font-medium text-gray-700">Worker URL Source</label>
          <select
            class="w-full rounded-md border border-gray-300 px-3 py-3 text-sm text-gray-900"
            onChange={(event) => {
              props.onWorkerUrlModeChange?.(event.currentTarget.value as 'manual' | 'runtime')
            }}
            value={props.value.workerUrlMode}
          >
            <option value="runtime">Runtime-discovered</option>
            <option value="manual">Saved manual URLs</option>
          </select>
          <div class="mt-3 rounded-lg border border-gray-200 bg-gray-50 px-4 py-3 text-sm text-gray-600">
            <div class="font-medium text-gray-700">Current runtime worker URLs</div>
            <div class="mt-1 break-words">
              {props.runtimeWorkerUrls && props.runtimeWorkerUrls.length > 0
                ? props.runtimeWorkerUrls.join(', ')
                : 'No active runtime detected'}
            </div>
          </div>
        </div>
      </Show>
      <Show
        when={props.supportsWorkerUrls && (!props.supportsRuntimeWorkerUrls || props.value.workerUrlMode === 'manual')}
      >
        <ProviderTextField
          label="Saved Manual Worker URLs"
          onInput={props.onWorkerUrlsChange}
          placeholder="http://127.0.0.1:30000, http://127.0.0.1:30001"
          type="text"
          value={props.value.manualWorkerUrls}
        />
      </Show>
      <Show when={props.showApiKeyField}>
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
      </Show>
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
