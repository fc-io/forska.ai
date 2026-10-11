import {For, Show} from 'solid-js'

import {formatJudgmentJobStopTime, formatNumber} from '../../jobsPageShared'
import type {StopConditionCountDefault, StopConditionDeadlineDefault} from './jobStopConditionDefaults.ts'
import {CalendarIcon, StopConditionMenuItem} from './jobStopConditionMenuItems.tsx'

export const StopConditionMenuNote = (props: {text: string; tone?: 'error' | 'muted'}) => {
  return (
    <p
      class={`break-words px-2 py-1 text-xs [overflow-wrap:anywhere] ${props.tone === 'error' ? 'text-red-600' : 'text-gray-500'}`}
      role={props.tone === 'error' ? 'alert' : undefined}
    >
      {props.text}
    </p>
  )
}

const getCustomValueLabel = (currentValue: number | null, items: StopConditionCountDefault[]) => {
  const isDefaultValue = items.some((item) => {
    return item.value === currentValue
  })

  return currentValue === null || isDefaultValue ? undefined : formatNumber(currentValue)
}

export const StopConditionCountOptions = (props: {
  caption: string | null
  currentValue: number | null
  isSaving: boolean
  items: StopConditionCountDefault[]
  onClear: () => void
  onCustom: () => void
  onSelect: (value: number) => void
}) => {
  return (
    <>
      <Show when={props.caption}>
        {(caption) => {
          return <StopConditionMenuNote text={caption()} />
        }}
      </Show>
      <For each={props.items}>
        {(item) => {
          return (
            <StopConditionMenuItem
              checked={item.value === props.currentValue}
              disabled={item.disabled || props.isSaving}
              label={item.label}
              onSelect={() => {
                props.onSelect(item.value)
              }}
            />
          )
        }}
      </For>
      <StopConditionMenuItem
        disabled={props.isSaving}
        hasSubmenu
        label="Custom…"
        value={getCustomValueLabel(props.currentValue, props.items)}
        onSelect={() => {
          props.onCustom()
        }}
      />
      <Show when={props.currentValue !== null}>
        <StopConditionMenuItem
          disabled={props.isSaving}
          label="Clear"
          onSelect={() => {
            props.onClear()
          }}
        />
      </Show>
    </>
  )
}

export const StopConditionDeadlineOptions = (props: {
  currentValue: Date | null
  isSaving: boolean
  items: StopConditionDeadlineDefault[]
  now: Date
  onClear: () => void
  onPick: () => void
  onSelect: (label: string) => void
}) => {
  return (
    <>
      <For each={props.items}>
        {(item) => {
          return (
            <StopConditionMenuItem
              disabled={props.isSaving}
              label={item.label}
              value={formatJudgmentJobStopTime(item.value, props.now)}
              onSelect={() => {
                props.onSelect(item.label)
              }}
            />
          )
        }}
      </For>
      <StopConditionMenuItem
        disabled={props.isSaving}
        hasSubmenu
        icon={<CalendarIcon />}
        label="Pick date and time…"
        onSelect={() => {
          props.onPick()
        }}
      />
      <Show when={props.currentValue !== null}>
        <StopConditionMenuItem
          disabled={props.isSaving}
          label="Clear"
          onSelect={() => {
            props.onClear()
          }}
        />
      </Show>
    </>
  )
}
