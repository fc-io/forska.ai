import {createMutation} from '@tanstack/solid-query'
import {createSignal, Show, splitProps, untrack} from 'solid-js'
import {createStore} from 'solid-js/store'

import {
  type ProviderModelCapabilities,
  type ProviderModelCapabilityOverrides,
  updateProviderModelCapabilityOverrides,
} from '../../+admin/+models/providerConnectionsClient.ts'
import {
  clearedProviderModelCapabilityOverrides,
  getProviderModelCapabilityFormState,
  getProviderModelCapabilityOverridesFromForm,
  hasProviderModelCapabilityOverride,
  type ProviderModelCapabilityFormState,
} from './providerModelCapabilityFormat.ts'

const inputClass = 'w-full rounded-md border border-gray-300 px-2 py-1 text-sm text-gray-900'
const labelClass = 'mb-1 block text-xs font-medium uppercase tracking-wide text-gray-500'
const buttonClass =
  'rounded-md border border-gray-300 px-2 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-60'

const preventFormSubmitOnEnter = (event: KeyboardEvent) => {
  if (event.key === 'Enter') {
    event.preventDefault()
  }
}

export const ProviderModelCapabilityEditor = (props: {
  capabilities: ProviderModelCapabilities | null
  modelId: string
  onClose: () => void
  onSaved: () => Promise<unknown>
}) => {
  const [local] = splitProps(props, ['capabilities', 'modelId', 'onClose', 'onSaved'])
  const [form, setForm] = createStore<ProviderModelCapabilityFormState>(
    untrack(() => {
      return getProviderModelCapabilityFormState(local.capabilities)
    }),
  )
  const [formError, setFormError] = createSignal<string | null>(null)
  const saveMutation = createMutation(() => {
    return {
      mutationFn: (overrides: ProviderModelCapabilityOverrides) => {
        return updateProviderModelCapabilityOverrides({id: local.modelId, overrides})
      },
      onSuccess: async () => {
        await local.onSaved()
        local.onClose()
      },
    }
  })
  const submitForm = () => {
    const result = getProviderModelCapabilityOverridesFromForm(form)

    setFormError(result.error)

    return result.overrides ? saveMutation.mutate(result.overrides) : undefined
  }

  return (
    <div class="mt-2 space-y-2 rounded-md border border-gray-200 bg-gray-50 p-2">
      <div class="grid grid-cols-2 gap-2">
        <label>
          <span class={labelClass}>Input tokens</span>
          <input
            class={inputClass}
            min="1"
            onInput={(event) => {
              return setForm('inputTokens', event.currentTarget.value)
            }}
            onKeyDown={preventFormSubmitOnEnter}
            type="number"
            value={form.inputTokens}
          />
        </label>
        <label>
          <span class={labelClass}>Total tokens</span>
          <input
            class={inputClass}
            min="1"
            onInput={(event) => {
              return setForm('totalTokens', event.currentTarget.value)
            }}
            onKeyDown={preventFormSubmitOnEnter}
            placeholder="Optional"
            type="number"
            value={form.totalTokens}
          />
        </label>
        <label>
          <span class={labelClass}>Image input</span>
          <select
            class={inputClass}
            onChange={(event) => {
              return setForm('imageInput', event.currentTarget.value as ProviderModelCapabilityFormState['imageInput'])
            }}
            value={form.imageInput}
          >
            <option value="">Not set</option>
            <option value="true">Yes</option>
            <option value="false">No</option>
          </select>
        </label>
        <label>
          <span class={labelClass}>PDF input</span>
          <select
            class={inputClass}
            onChange={(event) => {
              return setForm('pdfInput', event.currentTarget.value as ProviderModelCapabilityFormState['pdfInput'])
            }}
            value={form.pdfInput}
          >
            <option value="">Not set</option>
            <option value="true">Yes</option>
            <option value="false">No</option>
          </select>
        </label>
      </div>
      <p class="text-xs text-gray-500">Blank fields keep the discovered or shipped value.</p>
      <Show when={formError() ?? (saveMutation.error instanceof Error ? saveMutation.error.message : null)}>
        {(message) => {
          return <p class="text-xs text-red-600">{message()}</p>
        }}
      </Show>
      <div class="flex flex-wrap gap-2">
        <button class={buttonClass} disabled={saveMutation.isPending} onClick={submitForm} type="button">
          {saveMutation.isPending ? 'Saving...' : 'Save override'}
        </button>
        <Show when={hasProviderModelCapabilityOverride(local.capabilities)}>
          <button
            class={buttonClass}
            disabled={saveMutation.isPending}
            onClick={() => {
              return saveMutation.mutate(clearedProviderModelCapabilityOverrides)
            }}
            type="button"
          >
            Clear override
          </button>
        </Show>
        <button
          class={buttonClass}
          disabled={saveMutation.isPending}
          onClick={() => {
            return local.onClose()
          }}
          type="button"
        >
          Cancel
        </button>
      </div>
    </div>
  )
}
