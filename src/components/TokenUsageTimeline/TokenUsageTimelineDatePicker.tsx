import {type DateValue} from '@internationalized/date'
import {type Accessor, createMemo, Index} from 'solid-js'
import {Portal} from 'solid-js/web'

import {
  DatePicker,
  DatePickerControl,
  DatePickerContent,
  DatePickerContext,
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
  getOffset: (params: {months: number}) => {
    weeks: Array<Array<{day: string; value: DateValue}>>
    visibleRange: {start: DateValue; end: DateValue}
  }
  weekDays: Array<{short: string}>
  weeks: Array<Array<{day: string; value: DateValue}>>
  getMonthsGrid: (params: {columns: number; format: 'short'}) => Array<Array<{label: string; value: DateValue}>>
  getYearsGrid: (params: {columns: number}) => Array<Array<{label: string; value: DateValue}>>
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
  values: DateValue[]
}

const getTriggerClass = (hasCustomRange: boolean) => {
  return hasCustomRange
    ? 'border-blue-500 bg-blue-50 text-blue-600 hover:bg-blue-100'
    : 'border-gray-300 text-gray-600 hover:bg-gray-50'
}

const resetSelection = (params: ResetParams) => {
  params.onReset()
  params.api().clearValue()
  params.api().setOpen(false)
}

const updateRangeFromValues = (params: ValueChangeParams) => {
  params.onPendingChange(params.values)
  const range = getTokenUsageTimelineDateRange({values: params.values, timeZone: params.timeZone})
  if (!range) {
    return
  }
  params.onRangeCommit(range)
}

export const TokenUsageTimelineDatePicker = (props: TokenUsageTimelineDatePickerProps) => {
  return (
    <DatePicker
      locale="sv-SE"
      max={props.maxSelectableDate}
      numOfMonths={2}
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
          class={getTriggerClass(props.hasCustomRange())}
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
                                return (
                                  <DatePickerTableRow>
                                    <Index each={week()}>
                                      {(day) => {
                                        return (
                                          <DatePickerTableCell value={day()}>
                                            <DatePickerTableCellTrigger>{day().day}</DatePickerTableCellTrigger>
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
                                return (
                                  <DatePickerTableRow>
                                    <Index each={week()}>
                                      {(day) => {
                                        return (
                                          <DatePickerTableCell value={day()} visibleRange={offset().visibleRange}>
                                            <DatePickerTableCellTrigger>{day().day}</DatePickerTableCellTrigger>
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
                        Use interval range
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
