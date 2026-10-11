import {createSignal, Show} from 'solid-js'

import {
  NumberField,
  NumberFieldDescription,
  NumberFieldGroup,
  NumberFieldInput,
  NumberFieldLabel,
} from '../../../../../../components/ui/number-field.tsx'

export const stopConditionPrimaryButtonClass =
  'rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50'
export const stopConditionSecondaryButtonClass =
  'rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-100 disabled:cursor-not-allowed disabled:opacity-50'

type StopConditionCustomViewProps = {
  caption: string
  inputLabel: string
  isSaving: boolean
  label: string
  maxValue: number
  onBack: () => void
  onSave: (value: number) => void
  value: number | null
}

export const StopConditionCustomView = (props: StopConditionCustomViewProps) => {
  const [draft, setDraft] = createSignal<number | null>(null)
  const canSave = () => {
    const value = draft()
    return value !== null && value > 0 && !props.isSaving
  }
  const save = () => {
    const value = draft()
    return value === null || !canSave() ? undefined : props.onSave(value)
  }

  return (
    <div class="space-y-3 px-2 py-2">
      <NumberField
        class="space-y-1"
        formatOptions={{maximumFractionDigits: 0}}
        maxValue={props.maxValue}
        minValue={1}
        rawValue={props.value ?? undefined}
        onRawValueChange={(value) => {
          setDraft(Number.isNaN(value) ? null : Math.trunc(value))
        }}
      >
        <NumberFieldLabel class="text-sm font-normal text-gray-800">{props.label}</NumberFieldLabel>
        <NumberFieldGroup>
          <NumberFieldInput
            aria-label={props.inputLabel}
            class="h-8 px-2 py-1"
            placeholder="Number"
            onKeyDown={(event) => {
              return event.key === 'Enter' ? save() : undefined
            }}
          />
        </NumberFieldGroup>
        <Show when={props.caption}>
          <NumberFieldDescription class="text-xs text-gray-500">{props.caption}</NumberFieldDescription>
        </Show>
      </NumberField>
      <div class="flex justify-end gap-2">
        <button
          type="button"
          class={stopConditionSecondaryButtonClass}
          onClick={() => {
            props.onBack()
          }}
        >
          Back
        </button>
        <button type="button" class={stopConditionPrimaryButtonClass} disabled={!canSave()} onClick={save}>
          {props.isSaving ? 'Saving…' : 'Save'}
        </button>
      </div>
    </div>
  )
}
