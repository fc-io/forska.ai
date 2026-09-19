import * as Select from '@kobalte/core/select'
import {createMemo, For, Show, splitProps} from 'solid-js'

export type MultiSelectOption = {label: string; value: string}

type MultiSelectProps = {
  ariaLabel: string
  disabled?: boolean
  name?: string
  onChange: (values: string[]) => void
  options: readonly MultiSelectOption[]
  placeholder?: string
  values: readonly string[]
}

export const getIsSameMultiSelectOptionList = (
  left: readonly MultiSelectOption[],
  right: readonly MultiSelectOption[],
) => {
  return (
    left.length === right.length
    && left.every((option, index) => {
      return option.value === right[index]?.value && option.label === right[index]?.label
    })
  )
}

export const MultiSelect = (props: MultiSelectProps) => {
  const [local] = splitProps(props, ['ariaLabel', 'disabled', 'name', 'onChange', 'options', 'placeholder', 'values'])
  const placeholder = () => {
    return local.placeholder ?? 'All'
  }
  const getDisplayLabel = (value: string) => {
    return (
      local.options.find((option) => {
        return option.value === value
      })?.label ?? value
    )
  }
  const selectedOptions = createMemo(
    () => {
      return local.options.filter((option) => {
        return local.values.includes(option.value)
      })
    },
    undefined,
    {equals: getIsSameMultiSelectOptionList},
  )

  return (
    <Select.Root<MultiSelectOption>
      multiple
      value={selectedOptions()}
      onChange={(selectedOptions) => {
        local.onChange(
          selectedOptions.map((option) => {
            return option.value
          }),
        )
      }}
      options={local.options as MultiSelectOption[]}
      optionValue="value"
      optionTextValue="label"
      placeholder={placeholder()}
      name={local.name}
      disabled={local.disabled}
      itemComponent={(itemProps) => {
        return (
          <Select.Item
            item={itemProps.item}
            class="relative flex w-full cursor-default select-none items-center rounded-sm py-1.5 pl-2 pr-8 text-sm text-gray-900 outline-none data-[disabled]:pointer-events-none data-[highlighted]:bg-gray-100 data-[disabled]:opacity-50"
          >
            <Select.ItemLabel class="truncate">{itemProps.item.rawValue.label}</Select.ItemLabel>
            <Select.ItemIndicator class="absolute right-2 flex h-3.5 w-3.5 items-center justify-center">
              <svg
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="3"
                stroke-linecap="round"
                stroke-linejoin="round"
                class="size-3"
              >
                <path d="M5 12l5 5l10 -10" />
              </svg>
            </Select.ItemIndicator>
          </Select.Item>
        )
      }}
    >
      <Select.Trigger
        class="group min-h-11 w-full rounded-md border border-input bg-white px-2 py-1.5 text-sm text-gray-900 shadow-sm transition-[box-shadow,background-color] flex items-center gap-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring data-[expanded]:ring-2 data-[expanded]:ring-ring"
        aria-label={local.ariaLabel}
      >
        <div class="flex flex-wrap gap-2 grow">
          <Show when={local.values.length > 0} fallback={<span class="text-gray-500">{placeholder()}</span>}>
            <For each={local.values}>
              {(value) => {
                const displayLabel = getDisplayLabel(value)
                return (
                  <span class="inline-flex items-center gap-1 rounded-md border border-input bg-muted/70 px-2 py-1 text-sm text-foreground">
                    <span class="truncate max-w-[10rem]" title={displayLabel}>
                      {displayLabel}
                    </span>
                    <button
                      type="button"
                      class="inline-flex size-4 items-center justify-center rounded hover:bg-muted-foreground/10"
                      aria-label={`Remove ${displayLabel}`}
                      onClick={() => {
                        local.onChange(
                          local.values.filter((candidate) => {
                            return candidate !== value
                          }),
                        )
                      }}
                    >
                      <svg
                        xmlns="http://www.w3.org/2000/svg"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="2"
                        stroke-linecap="round"
                        stroke-linejoin="round"
                        class="size-3"
                      >
                        <path d="M18 6L6 18" />
                        <path d="M6 6l12 12" />
                      </svg>
                    </button>
                  </span>
                )
              }}
            </For>
          </Show>
        </div>
        <div class="ml-auto flex items-center gap-1">
          <button
            type="button"
            class="inline-flex size-6 items-center justify-center rounded hover:bg-muted-foreground/10"
            title="Clear selection"
            aria-label="Clear selection"
            onClick={() => {
              local.onChange([])
            }}
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
              class="size-4 opacity-70"
            >
              <path d="M18 6L6 18" />
              <path d="M6 6l12 12" />
            </svg>
          </button>
          <Select.Icon>
            <svg
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
              class="size-4 opacity-60"
            >
              <path d="M6 9l6 6l6 -6" />
            </svg>
          </Select.Icon>
        </div>
      </Select.Trigger>
      <Select.Portal>
        <Select.Content class="z-50 min-w-56 rounded-md border border-input bg-white p-1 text-gray-900 shadow-xl outline-none">
          <Select.Listbox class="max-h-60 overflow-auto outline-none" />
        </Select.Content>
      </Select.Portal>
    </Select.Root>
  )
}
