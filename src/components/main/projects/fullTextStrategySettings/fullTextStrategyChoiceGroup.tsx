import {For, Show, splitProps} from 'solid-js'

export type FullTextStrategyChoice<T extends number | string> = {description?: string; label: string; value: T}

type FullTextStrategyChoiceGroupProps<T extends number | string> = {
  disabled?: boolean
  legend: string
  name: string
  onChange: (value: T) => void
  options: ReadonlyArray<FullTextStrategyChoice<T>>
  value: T | null
}

export const FullTextStrategyChoiceGroup = <T extends number | string>(props: FullTextStrategyChoiceGroupProps<T>) => {
  const [local] = splitProps(props, ['disabled', 'legend', 'name', 'onChange', 'options', 'value'])

  return (
    <fieldset class="space-y-2" disabled={local.disabled}>
      <legend class="text-sm font-medium text-gray-900 mb-1">{local.legend}</legend>
      <div class="grid gap-2 sm:grid-cols-3">
        <For each={local.options}>
          {(option) => {
            return (
              <label class="flex items-start gap-2 border border-input rounded-md p-2 cursor-pointer">
                <input
                  type="radio"
                  class="mt-1"
                  name={local.name}
                  value={String(option.value)}
                  checked={local.value === option.value}
                  onChange={() => {
                    local.onChange(option.value)
                  }}
                />
                <span class="flex-1">
                  <span class="block text-sm text-gray-900">{option.label}</span>
                  <Show when={option.description}>
                    <span class="block text-xs text-gray-500 mt-0.5">{option.description}</span>
                  </Show>
                </span>
              </label>
            )
          }}
        </For>
      </div>
    </fieldset>
  )
}
