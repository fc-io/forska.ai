import {type DateValue} from '@internationalized/date'
import {type Accessor, createMemo, Index} from 'solid-js'
import {Portal} from 'solid-js/web'

import {getWeekNumberLabel} from '../../utils/getWeekNumber'
import {
  DatePicker,
  DatePickerContent,
  DatePickerContext,
  DatePickerControl,
  DatePickerNextTrigger,
  DatePickerPositioner,
  DatePickerPrevTrigger,
  DatePickerRangeText,
  DatePickerTable,
  DatePickerTableBody,
  DatePickerTableCell,
  DatePickerTableCellTrigger,
  DatePickerTableHead,
  DatePickerTableHeader,
  DatePickerTableRow,
  DatePickerTrigger,
  DatePickerView,
  DatePickerViewControl,
  DatePickerViewTrigger,
} from '../ui/date-picker'
import {getTokenUsageTimelineDateRange, type TokenUsageTimelineDateRange} from './TokenUsageTimelineDateRange'

type TokenUsageTimelineDatePickerApi = {
  clearValue: () => void
  setOpen: (open: boolean) => void
  getOffset: (params: {months: number}) => {weeks: DateValue[][]; visibleRange: {start: DateValue; end: DateValue}}
  weekDays: Array<{short: string}>
  weeks: DateValue[][]
  getMonthsGrid: (params: {columns: number; format: 'short'}) => Array<Array<{label: string; value: number}>>
  getYearsGrid: (params: {columns: number}) => Array<Array<{label: string; value: number}>>
}

type TokenUsageTimelineDatePickerProps = {
  hasCustomRange: Accessor<boolean>
  maxSelectableDate: DateValue
  onPendingChange: (values: DateValue[] | undefined) => void
  onRangeCommit: (range: TokenUsageTimelineDateRange) => void
  onReset: () => void
  pickerValue: Accessor<DateValue[] | undefined>
  timeZone: string
}

type ResetParams = {api: Accessor<TokenUsageTimelineDatePickerApi>; onReset: () => void}

type ValueChangeParams = {
  onPendingChange: (values: DateValue[] | undefined) => void
  onRangeCommit: (range: TokenUsageTimelineDateRange) => void
  timeZone: string
  values: DateValue[] | undefined
}

const getTriggerClass = (params: {hasCustomRange: boolean}) => {
  const openStateClass =
    'data-[state=open]:border-blue-500 data-[state=open]:bg-blue-50 data-[state=open]:text-blue-600'
  return params.hasCustomRange
    ? `${openStateClass} border-blue-500 bg-blue-50 text-blue-600 hover:bg-blue-100`
    : `${openStateClass} border-gray-300 text-gray-600 hover:bg-gray-50`
}

const dayCellClass =
  'has-[[data-in-range]]:!bg-blue-100 has-[[data-in-range]]:!text-blue-700 has-[[data-in-range]]:first-of-type:rounded-l-md has-[[data-in-range]]:last-of-type:rounded-r-md has-[[data-selected]]:!bg-blue-600 has-[[data-selected]]:!text-white has-[[data-disabled]]:!bg-gray-50 has-[[data-disabled]]:!text-gray-400'

const dayTriggerClass =
  'font-medium transition-colors data-[today]:!border data-[today]:!border-emerald-500 data-[today]:!bg-emerald-50 data-[today]:!text-emerald-700 data-[today]:font-semibold data-[range-start]:ring-2 data-[range-start]:ring-blue-300 data-[range-start]:ring-offset-1 data-[range-end]:ring-2 data-[range-end]:ring-blue-300 data-[range-end]:ring-offset-1 data-[selected]:!bg-blue-600 data-[selected]:!text-white data-[selected]:hover:!bg-blue-600 data-[selected]:hover:!text-white data-[in-range]:!bg-blue-50 data-[in-range]:!text-blue-700 data-[in-range]:hover:!bg-blue-50 data-[disabled]:!bg-gray-100 data-[disabled]:!text-gray-400 data-[disabled]:!opacity-100 data-[disabled]:!cursor-not-allowed data-[disabled]:hover:!bg-gray-100 data-[disabled]:hover:!text-gray-400 data-[outside-range]:text-gray-400 data-[outside-range]:opacity-80 data-[outside-range]:hover:text-gray-600 data-[outside-range]:hover:bg-gray-100 data-[outside-range]:hover:opacity-100 [&:is([data-outside-range][data-selected])]:opacity-100 [&:is([data-outside-range][data-selected])]:text-white'

const weekHeaderClass = 'flex w-8 flex-none items-center justify-center text-[0.65rem] font-medium text-gray-400'

const weekCellClass = 'flex w-8 flex-none items-center justify-center text-[0.65rem] font-medium text-gray-400'

const resetSelection = (params: ResetParams) => {
  params.onReset()
  params.api().clearValue()
  params.api().setOpen(false)
}

const updateRangeFromValues = (params: ValueChangeParams) => {
  const values = params.values
  if (!values || values.length === 0) {
    params.onPendingChange(undefined)
    return
  }
  if (values.length < 2) {
    params.onPendingChange(values)
    return
  }
  params.onPendingChange(values)
  const range = getTokenUsageTimelineDateRange({values, timeZone: params.timeZone})
  if (!range) {
    return
  }
  params.onRangeCommit(range)
}

export const TokenUsageTimelineDatePicker = (props: TokenUsageTimelineDatePickerProps) => {
  return (
    <DatePicker
      lazyMount
      unmountOnExit
      locale="sv-SE"
      max={props.maxSelectableDate}
      numOfMonths={2}
      outsideDaySelectable
      selectionMode="range"
      value={props.pickerValue()}
      onValueChange={(details) => {
        return updateRangeFromValues({
          onPendingChange: props.onPendingChange,
          onRangeCommit: props.onRangeCommit,
          timeZone: props.timeZone,
          values: details.value,
        })
      }}
    >
      <DatePickerControl>
        <DatePickerTrigger
          aria-label="Select custom date range"
          class={getTriggerClass({hasCustomRange: props.hasCustomRange()})}
          title="Select custom date range"
        />
      </DatePickerControl>
      <Portal>
        <DatePickerPositioner>
          <DatePickerContent class="bg-white">
            <DatePickerContext>
              {(api: Accessor<TokenUsageTimelineDatePickerApi>) => {
                const offset = createMemo(() => {
                  return api().getOffset({months: 1})
                })
                return (
                  <>
                    <DatePickerView view="day">
                      <DatePickerViewControl>
                        <DatePickerPrevTrigger />
                        <DatePickerViewTrigger>
                          <DatePickerRangeText />
                        </DatePickerViewTrigger>
                        <DatePickerNextTrigger />
                      </DatePickerViewControl>
                      <div class="grid grid-cols-1 gap-4 md:grid-cols-2">
                        <DatePickerTable>
                          <DatePickerTableHead>
                            <DatePickerTableRow>
                              <th class={weekHeaderClass}>
                                <span class="sr-only">Week</span>
                              </th>
                              <Index each={api().weekDays}>
                                {(weekDay) => {
                                  return <DatePickerTableHeader>{weekDay().short}</DatePickerTableHeader>
                                }}
                              </Index>
                            </DatePickerTableRow>
                          </DatePickerTableHead>
                          <DatePickerTableBody>
                            <Index each={api().weeks}>
                              {(week) => {
                                const days = createMemo(() => {
                                  return week()
                                })
                                const weekLabel = createMemo(() => {
                                  return getWeekNumberLabel(days(), props.timeZone)
                                })
                                return (
                                  <DatePickerTableRow>
                                    <td class={weekCellClass}>{weekLabel()}</td>
                                    <Index each={days()}>
                                      {(day) => {
                                        return (
                                          <DatePickerTableCell class={dayCellClass} value={day()}>
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
                        <DatePickerTable>
                          <DatePickerTableHead>
                            <DatePickerTableRow>
                              <th class={weekHeaderClass}>
                                <span class="sr-only">Week</span>
                              </th>
                              <Index each={api().weekDays}>
                                {(weekDay) => {
                                  return <DatePickerTableHeader>{weekDay().short}</DatePickerTableHeader>
                                }}
                              </Index>
                            </DatePickerTableRow>
                          </DatePickerTableHead>
                          <DatePickerTableBody>
                            <Index each={offset().weeks}>
                              {(week) => {
                                const days = createMemo(() => {
                                  return week()
                                })
                                const weekLabel = createMemo(() => {
                                  return getWeekNumberLabel(days(), props.timeZone)
                                })
                                return (
                                  <DatePickerTableRow>
                                    <td class={weekCellClass}>{weekLabel()}</td>
                                    <Index each={days()}>
                                      {(day) => {
                                        return (
                                          <DatePickerTableCell
                                            class={dayCellClass}
                                            value={day()}
                                            visibleRange={offset().visibleRange}
                                          >
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
                      </div>
                    </DatePickerView>
                    <DatePickerView view="month">
                      <DatePickerViewControl>
                        <DatePickerPrevTrigger />
                        <DatePickerViewTrigger>
                          <DatePickerRangeText />
                        </DatePickerViewTrigger>
                        <DatePickerNextTrigger />
                      </DatePickerViewControl>
                      <DatePickerTable>
                        <DatePickerTableBody>
                          <Index each={api().getMonthsGrid({columns: 4, format: 'short'})}>
                            {(months) => {
                              return (
                                <DatePickerTableRow>
                                  <Index each={months()}>
                                    {(month) => {
                                      return (
                                        <DatePickerTableCell value={month().value}>
                                          <DatePickerTableCellTrigger>{month().label}</DatePickerTableCellTrigger>
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
                    </DatePickerView>
                    <DatePickerView view="year">
                      <DatePickerViewControl>
                        <DatePickerPrevTrigger />
                        <DatePickerViewTrigger>
                          <DatePickerRangeText />
                        </DatePickerViewTrigger>
                        <DatePickerNextTrigger />
                      </DatePickerViewControl>
                      <DatePickerTable>
                        <DatePickerTableBody>
                          <Index each={api().getYearsGrid({columns: 4})}>
                            {(years) => {
                              return (
                                <DatePickerTableRow>
                                  <Index each={years()}>
                                    {(year) => {
                                      return (
                                        <DatePickerTableCell value={year().value}>
                                          <DatePickerTableCellTrigger>{year().label}</DatePickerTableCellTrigger>
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
                    </DatePickerView>
                    <div class="mt-4 flex justify-start border-t pt-3">
                      <button
                        type="button"
                        class="rounded-md border border-gray-300 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"
                        disabled={!props.hasCustomRange()}
                        onClick={() => {
                          return resetSelection({api, onReset: props.onReset})
                        }}
                      >
                        Show Live
                      </button>
                    </div>
                  </>
                )
              }}
            </DatePickerContext>
          </DatePickerContent>
        </DatePickerPositioner>
      </Portal>
    </DatePicker>
  )
}
