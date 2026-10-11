import {createSignal, For, type JSX, Show} from 'solid-js'

import {
  NumberField,
  NumberFieldDescription,
  NumberFieldGroup,
  NumberFieldInput,
  NumberFieldLabel,
} from '../../../../../../components/ui/number-field.tsx'
import {cn} from '../../../../../../utils/cn.ts'
import {getActionErrorMessage} from '../../jobsPageShared'
import {getDateFromDateTimeLocalInput, getDateTimeLocalInputValue, stopAtQuickPicks} from './jobStopConditionTime.ts'

type SaveStatus = 'failed' | 'idle' | 'saved' | 'saving'
type SaveState = {message: string | null; status: SaveStatus}
type SaveAction = () => Promise<unknown>

const saveStatusLabels: Record<SaveStatus, string> = {failed: 'Failed', idle: '', saved: 'Saved', saving: 'Saving…'}
const saveStatusClasses: Record<SaveStatus, string> = {
  failed: 'text-red-600',
  idle: 'text-gray-500',
  saved: 'text-green-700',
  saving: 'text-gray-500',
}
const compactButtonClass =
  'rounded border border-gray-300 bg-white px-1.5 py-0.5 text-xs text-gray-700 hover:bg-gray-100 disabled:cursor-not-allowed disabled:opacity-50'

const createSaveState = () => {
  const [saveState, setSaveState] = createSignal<SaveState>({message: null, status: 'idle'})
  const runSave = async (save: SaveAction) => {
    setSaveState({message: null, status: 'saving'})
    await save().then(
      () => {
        setSaveState({message: null, status: 'saved'})
      },
      (error: unknown) => {
        setSaveState({message: getActionErrorMessage(error, 'Failed to save'), status: 'failed'})
      },
    )
  }

  return {runSave, saveState}
}

const isEnterKey = (event: KeyboardEvent) => {
  return event.key === 'Enter'
}

const StopConditionSaveIndicator = (props: {state: SaveState}) => {
  return (
    <span role="status" aria-live="polite" class={cn('text-xs', saveStatusClasses[props.state.status])}>
      {saveStatusLabels[props.state.status]}
      <Show when={props.state.message}>
        {(message) => {
          return <span class="block break-words [overflow-wrap:anywhere]">{message()}</span>
        }}
      </Show>
    </span>
  )
}

export const StopConditionNumberRow = (props: {
  caption: string
  inputLabel: string
  label: string
  maxValue: number
  onSave: (value: number | null) => Promise<unknown>
  unit: string
  value: number | null
}) => {
  const {runSave, saveState} = createSaveState()
  const [draft, setDraft] = createSignal<number | null>(null)
  const commit = () => {
    const nextValue = draft()
    const onSave = props.onSave

    return nextValue === props.value || saveState().status === 'saving'
      ? undefined
      : void runSave(() => {
          return onSave(nextValue)
        })
  }

  return (
    <NumberField
      class="space-y-1 py-1"
      formatOptions={{maximumFractionDigits: 0}}
      maxValue={props.maxValue}
      minValue={1}
      rawValue={props.value ?? undefined}
      onRawValueChange={(value) => {
        setDraft(Number.isNaN(value) ? null : Math.trunc(value))
      }}
    >
      <div class="flex flex-wrap items-center gap-2 text-sm text-gray-800">
        <NumberFieldLabel class="font-normal">{props.label}</NumberFieldLabel>
        <NumberFieldGroup class="w-32">
          <NumberFieldInput
            aria-label={props.inputLabel}
            class="h-8 px-2 py-1"
            placeholder="Off"
            onBlur={commit}
            onKeyDown={(event) => {
              return isEnterKey(event) ? commit() : undefined
            }}
          />
        </NumberFieldGroup>
        <span>{props.unit}</span>
        <StopConditionSaveIndicator state={saveState()} />
      </div>
      <NumberFieldDescription class="text-xs text-gray-500">{props.caption}</NumberFieldDescription>
    </NumberField>
  )
}

export const StopConditionCheckboxRow = (props: {
  checked: boolean
  label: string
  onSave: (checked: boolean) => Promise<unknown>
}) => {
  const {runSave, saveState} = createSaveState()

  return (
    <div class="flex flex-wrap items-center gap-2 py-1 text-sm text-gray-800">
      <label class="flex items-center gap-2">
        <input
          type="checkbox"
          class="size-4 rounded border-gray-300"
          checked={props.checked}
          disabled={saveState().status === 'saving'}
          onChange={(event) => {
            const checked = event.currentTarget.checked
            const onSave = props.onSave

            return void runSave(() => {
              return onSave(checked)
            })
          }}
        />
        {props.label}
      </label>
      <StopConditionSaveIndicator state={saveState()} />
    </div>
  )
}

const isSameStopAt = (left: Date | null, right: Date | null) => {
  return left?.getTime() === right?.getTime()
}

export const StopConditionDeadlineRow = (props: {
  onSave: (stopAt: string | null) => Promise<unknown>
  value: Date | null
}) => {
  const {runSave, saveState} = createSaveState()
  const save = (stopAt: Date | null) => {
    const onSave = props.onSave

    return isSameStopAt(stopAt, props.value)
      ? undefined
      : void runSave(() => {
          return onSave(stopAt?.toISOString() ?? null)
        })
  }
  const commitInput: JSX.EventHandler<HTMLInputElement, Event> = (event) => {
    return event.currentTarget.validity.badInput
      ? undefined
      : save(getDateFromDateTimeLocalInput(event.currentTarget.value))
  }

  return (
    <div class="space-y-1 py-1 text-sm text-gray-800">
      <div class="flex flex-wrap items-center gap-2">
        <label class="flex items-center gap-2">
          Pause at
          <input
            type="datetime-local"
            aria-label="Pause at date and time"
            class="h-8 rounded-md border border-input bg-transparent px-2 py-1 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            value={getDateTimeLocalInputValue(props.value)}
            onBlur={commitInput}
            onKeyDown={(event) => {
              return isEnterKey(event) ? commitInput(event) : undefined
            }}
          />
        </label>
        <Show when={props.value}>
          <button
            type="button"
            class={compactButtonClass}
            disabled={saveState().status === 'saving'}
            onClick={() => {
              return save(null)
            }}
          >
            Clear
          </button>
        </Show>
        <StopConditionSaveIndicator state={saveState()} />
      </div>
      <div class="flex flex-wrap gap-1">
        <For each={stopAtQuickPicks}>
          {(quickPick) => {
            return (
              <button
                type="button"
                class={compactButtonClass}
                disabled={saveState().status === 'saving'}
                onClick={() => {
                  return save(quickPick.getStopAt(new Date()))
                }}
              >
                {quickPick.label}
              </button>
            )
          }}
        </For>
      </div>
    </div>
  )
}
