import {type JSX, Show, splitProps} from 'solid-js'

type ProviderReadonlyFieldProps = {label: string; value: string}

export const ProviderReadonlyField = (props: ProviderReadonlyFieldProps) => {
  return (
    <div>
      <label class="mb-2 block text-sm font-medium text-gray-700">{props.label}</label>
      <div class="rounded-md border border-gray-200 bg-gray-50 px-3 py-3 text-sm text-gray-700">{props.value}</div>
    </div>
  )
}

type ProviderTextFieldProps = {
  label: string
  onInput: (value: string) => void
  placeholder?: string
  type?: string
  value: string
}

export const ProviderTextField = (props: ProviderTextFieldProps) => {
  const [local, inputProps] = splitProps(props, ['label', 'onInput'])

  return (
    <div>
      <label class="mb-2 block text-sm font-medium text-gray-700">{local.label}</label>
      <input
        {...inputProps}
        class="w-full rounded-md border border-gray-300 px-3 py-3 text-sm text-gray-900"
        onInput={(event) => {
          local.onInput(event.currentTarget.value)
        }}
      />
    </div>
  )
}

type ProviderApiKeyFieldProps = {
  clearButtonLabel?: string
  hasStoredSecret?: boolean
  label: string
  onClearStoredSecret?: () => void
  onInput: (value: string) => void
  optional?: boolean
  placeholder?: string
  secretStatus?: string
  value: string
}

export const ProviderApiKeyField = (props: ProviderApiKeyFieldProps) => {
  const [local, inputProps] = splitProps(props, [
    'clearButtonLabel',
    'hasStoredSecret',
    'label',
    'onClearStoredSecret',
    'onInput',
    'optional',
    'secretStatus',
  ])

  return (
    <div class="rounded-lg border border-gray-200 bg-gray-50 p-4">
      <div class="flex items-center justify-between gap-3">
        <label class="text-sm font-medium text-gray-700">{local.label}</label>
        <Show when={local.secretStatus}>
          <span class="text-xs font-medium uppercase tracking-wide text-gray-500">{local.secretStatus}</span>
        </Show>
      </div>
      <input
        {...inputProps}
        class="mt-2 w-full rounded-md border border-gray-300 bg-white px-3 py-3 text-sm text-gray-900"
        onInput={(event) => {
          local.onInput(event.currentTarget.value)
        }}
        placeholder={inputProps.placeholder ?? (local.optional ? 'Optional' : undefined)}
        type="password"
      />
      <Show when={local.hasStoredSecret && local.onClearStoredSecret}>
        <div class="mt-3 flex justify-end">
          <button
            class="rounded-md border border-gray-300 px-3 py-2 text-sm font-medium text-gray-700 hover:bg-white"
            onClick={() => {
              local.onClearStoredSecret?.()
            }}
            type="button"
          >
            {local.clearButtonLabel ?? 'Clear Stored Key'}
          </button>
        </div>
      </Show>
    </div>
  )
}

type ProviderEnabledToggleProps = {checked: boolean; onChange: (checked: boolean) => void}

export const ProviderEnabledToggle = (props: ProviderEnabledToggleProps) => {
  return (
    <label class="flex items-center gap-3 rounded-lg border border-gray-200 bg-gray-50 px-3 py-3 text-sm text-gray-700">
      <input
        checked={props.checked}
        onChange={(event) => {
          props.onChange(event.currentTarget.checked)
        }}
        type="checkbox"
      />
      Enabled
    </label>
  )
}

export const getProviderFormSection = (children: JSX.Element) => {
  return <div class="space-y-4">{children}</div>
}
