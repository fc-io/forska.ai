import {CalendarDate, getLocalTimeZone, toCalendarDate, today} from '@internationalized/date'
import {createSignal, For, Index, Show} from 'solid-js'

import {
  DatePicker,
  DatePickerContext,
  DatePickerNextTrigger,
  DatePickerPrevTrigger,
  DatePickerRangeText,
  DatePickerTable,
  DatePickerTableBody,
  DatePickerTableCell,
  DatePickerTableCellTrigger,
  DatePickerTableHead,
  DatePickerTableHeader,
  DatePickerTableRow,
  DatePickerView,
  DatePickerViewControl,
} from '../../../../../../components/ui/date-picker.tsx'
import {stopConditionPrimaryButtonClass, stopConditionSecondaryButtonClass} from './jobStopConditionCustomView.tsx'
import {getStopAtFromParts, getStopAtHourOptions, getStopAtMinuteOptions} from './jobStopConditionDefaults.ts'

type StopConditionDeadlinePickerProps = {
  initial: Date
  isSaving: boolean
  now: () => Date
  onBack: () => void
  onSave: (stopAt: Date) => void
}

const dayTriggerClass =
  'data-[today]:font-semibold data-[today]:text-blue-700 data-[selected]:!bg-blue-600 data-[selected]:!text-white data-[disabled]:!text-gray-300'
const selectClass =
  'h-8 rounded-md border border-gray-300 bg-white px-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500'

const formatTimePart = (value: number) => {
  return String(value).padStart(2, '0')
}

const getCalendarDate = (date: Date) => {
  return new CalendarDate(date.getFullYear(), date.getMonth() + 1, date.getDate())
}

export const StopConditionDeadlinePicker = (props: StopConditionDeadlinePickerProps) => {
  const [date, setDate] = createSignal(getCalendarDate(props.initial))
  const [hour, setHour] = createSignal(props.initial.getHours())
  const [minute, setMinute] = createSignal(props.initial.getMinutes())
  const stopAt = () => {
    return getStopAtFromParts({day: date().day, hour: hour(), minute: minute(), month: date().month, year: date().year})
  }
  const isFuture = () => {
    return stopAt().getTime() > props.now().getTime()
  }

  return (
    <div class="space-y-2 px-2 py-2">
      <DatePicker
        inline
        locale="en-GB"
        min={today(getLocalTimeZone())}
        selectionMode="single"
        value={[date()]}
        onValueChange={(details) => {
          const [nextDate] = details.value
          return nextDate ? setDate(toCalendarDate(nextDate)) : undefined
        }}
      >
        <DatePickerView view="day" class="space-y-2">
          <DatePickerContext>
            {(api) => {
              return (
                <>
                  <DatePickerViewControl>
                    <DatePickerPrevTrigger />
                    <DatePickerRangeText />
                    <DatePickerNextTrigger />
                  </DatePickerViewControl>
                  <DatePickerTable>
                    <DatePickerTableHead>
                      <DatePickerTableRow>
                        <Index each={api().weekDays}>
                          {(weekDay) => {
                            return <DatePickerTableHeader>{weekDay().narrow}</DatePickerTableHeader>
                          }}
                        </Index>
                      </DatePickerTableRow>
                    </DatePickerTableHead>
                    <DatePickerTableBody>
                      <Index each={api().weeks}>
                        {(week) => {
                          return (
                            <DatePickerTableRow>
                              <Index each={week()}>
                                {(day) => {
                                  return (
                                    <DatePickerTableCell value={day()}>
                                      <DatePickerTableCellTrigger class={dayTriggerClass}>
                                        {day().day}
                                      </DatePickerTableCellTrigger>
                                    </DatePickerTableCell>
                                  )
                                }}
                              </Index>
                            </DatePickerTableRow>
                          )
                        }}
                      </Index>
                    </DatePickerTableBody>
                  </DatePickerTable>
                </>
              )
            }}
          </DatePickerContext>
        </DatePickerView>
      </DatePicker>
      <div class="flex items-center gap-2 text-sm text-gray-800">
        <span>Time</span>
        <select
          aria-label="Hour"
          class={selectClass}
          value={hour()}
          onChange={(event) => {
            setHour(Number(event.currentTarget.value))
          }}
        >
          <For each={getStopAtHourOptions()}>
            {(option) => {
              return <option value={option}>{formatTimePart(option)}</option>
            }}
          </For>
        </select>
        <span>:</span>
        <select
          aria-label="Minute"
          class={selectClass}
          value={minute()}
          onChange={(event) => {
            setMinute(Number(event.currentTarget.value))
          }}
        >
          <For each={getStopAtMinuteOptions(minute())}>
            {(option) => {
              return <option value={option}>{formatTimePart(option)}</option>
            }}
          </For>
        </select>
      </div>
      <Show when={!isFuture()}>
        <p class="text-xs text-amber-800">Pick a time in the future.</p>
      </Show>
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
        <button
          type="button"
          class={stopConditionPrimaryButtonClass}
          disabled={!isFuture() || props.isSaving}
          onClick={() => {
            props.onSave(stopAt())
          }}
        >
          {props.isSaving ? 'Saving…' : 'Save'}
        </button>
      </div>
    </div>
  )
}
