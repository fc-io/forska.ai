import {Match, Switch} from 'solid-js'

import {AnthropicProviderForm} from './anthropicProviderForm.tsx'
import {CodexProviderForm} from './codexProviderForm.tsx'
import {GoogleProviderForm} from './googleProviderForm.tsx'
import {OpenAICompatibleProviderForm} from './openAICompatibleProviderForm.tsx'
import {OpenaiProviderForm} from './openaiProviderForm.tsx'

export type ProviderConnectionFormValues = {
  apiKey: string
  baseURL: string
  enabled: boolean
  label: string
  manualWorkerUrls: string
  workerUrlMode: 'manual' | 'runtime'
}

export type ProviderConnectionFormProps = {
  apiKeyLabel?: string
  apiKeyOptional?: boolean
  hasStoredSecret?: boolean
  kind: string
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
  showBaseURLField?: boolean
  showEnabledToggle?: boolean
  supportsRuntimeWorkerUrls?: boolean
  supportsWorkerUrls?: boolean
  values: ProviderConnectionFormValues
}

export const ProviderConnectionForm = (props: ProviderConnectionFormProps) => {
  return (
    <Switch>
      <Match when={props.kind === 'openai'}>
        <OpenaiProviderForm
          apiKeyLabel={props.apiKeyLabel}
          apiKeyOptional={props.apiKeyOptional}
          hasStoredSecret={props.hasStoredSecret}
          onApiKeyChange={props.onApiKeyChange}
          onBaseURLChange={props.onBaseURLChange}
          onClearStoredSecret={props.onClearStoredSecret}
          onEnabledChange={props.onEnabledChange}
          onLabelChange={props.onLabelChange}
          providerLabel={props.providerLabel}
          secretStatus={props.secretStatus}
          showEnabledToggle={props.showEnabledToggle}
          value={props.values}
        />
      </Match>
      <Match when={props.kind === 'anthropic'}>
        <AnthropicProviderForm
          apiKeyLabel={props.apiKeyLabel}
          apiKeyOptional={props.apiKeyOptional}
          hasStoredSecret={props.hasStoredSecret}
          onApiKeyChange={props.onApiKeyChange}
          onBaseURLChange={props.onBaseURLChange}
          onClearStoredSecret={props.onClearStoredSecret}
          onEnabledChange={props.onEnabledChange}
          onLabelChange={props.onLabelChange}
          providerLabel={props.providerLabel}
          secretStatus={props.secretStatus}
          showEnabledToggle={props.showEnabledToggle}
          value={props.values}
        />
      </Match>
      <Match when={props.kind === 'google'}>
        <GoogleProviderForm
          apiKeyLabel={props.apiKeyLabel}
          apiKeyOptional={props.apiKeyOptional}
          hasStoredSecret={props.hasStoredSecret}
          onApiKeyChange={props.onApiKeyChange}
          onBaseURLChange={props.onBaseURLChange}
          onClearStoredSecret={props.onClearStoredSecret}
          onEnabledChange={props.onEnabledChange}
          onLabelChange={props.onLabelChange}
          providerLabel={props.providerLabel}
          secretStatus={props.secretStatus}
          showEnabledToggle={props.showEnabledToggle}
          value={props.values}
        />
      </Match>
      <Match when={props.kind === 'codex'}>
        <CodexProviderForm
          onEnabledChange={props.onEnabledChange}
          onLabelChange={props.onLabelChange}
          providerLabel={props.providerLabel}
          showEnabledToggle={props.showEnabledToggle}
          value={{enabled: props.values.enabled, label: props.values.label}}
        />
      </Match>
      <Match when>
        <OpenAICompatibleProviderForm
          apiKeyLabel={props.apiKeyLabel}
          apiKeyOptional={props.apiKeyOptional}
          hasStoredSecret={props.hasStoredSecret}
          onApiKeyChange={props.onApiKeyChange}
          onBaseURLChange={props.onBaseURLChange}
          onClearStoredSecret={props.onClearStoredSecret}
          onEnabledChange={props.onEnabledChange}
          onLabelChange={props.onLabelChange}
          onWorkerUrlModeChange={props.onWorkerUrlModeChange}
          onWorkerUrlsChange={props.onWorkerUrlsChange}
          providerLabel={props.providerLabel}
          runtimeWorkerUrls={props.runtimeWorkerUrls}
          secretStatus={props.secretStatus}
          showApiKeyField={props.showApiKeyField}
          showBaseURLField={props.showBaseURLField}
          showEnabledToggle={props.showEnabledToggle}
          supportsRuntimeWorkerUrls={props.supportsRuntimeWorkerUrls}
          supportsWorkerUrls={props.supportsWorkerUrls}
          value={props.values}
        />
      </Match>
    </Switch>
  )
}
