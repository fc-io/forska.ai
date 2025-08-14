import {fromDate} from '@internationalized/date'
import {type JSX} from 'solid-js'
import {createMemo, Index} from 'solid-js'
import {Portal} from 'solid-js/web'

import {
  DatePicker,
  DatePickerContent,
  DatePickerContext,
  DatePickerControl,
  DatePickerInput,
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
} from '../../../ui/date-picker'

export interface DateRangePickerProps {
  locale?: string
  numOfMonths?: number
  maxDate?: Date
  defaultStart: Date
  defaultEnd: defaultFocusedValue
  // eslint-disable-next-line no-unused-vars
  onValueChange?: (dates: [Date, Date]) => void
}

export const DateRangePicker = (props: DateRangePickerProps): JSX.Element => {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone
  const max = () => {
    return fromDate(props.maxDate ?? new Date(), tz)
  }

  return (
    <DatePicker
      max={max()}
      locale={props.locale ?? 'sv-SE'}
      numOfMonths={props.numOfMonths ?? 2}
      selectionMode="range"
      defaultValue={[
        fromDate(props.defaultStart, tz),
        fromDate(props.defaultEnd, tz),
      ]}
      onValueChange={(details) => {
        if (props.onValueChange && details.value.length === 2) {
          const [start, end] = details.value.map((date) => {
            return date.toDate(tz)
          })
          if (start && end) {
            props.onValueChange([start, end])
          }
        }
      }}
    >
      <DatePickerControl>
        <DatePickerInput index={0} class="bg-white" />
        <DatePickerInput index={1} class="bg-white" />
        <DatePickerTrigger class="bg-white" />
      </DatePickerControl>
      <Portal>
        <DatePickerPositioner>
          <DatePickerContent class="bg-white">
            <DatePickerView view="day">
              <DatePickerContext>
                {(api) => {
                  const offset = createMemo(() => {
                    return api().getOffset({months: 1})
                  })
                  return (
                    <>
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
                                  return (
                                    <DatePickerTableHeader>
                                      {weekDay().short}
                                    </DatePickerTableHeader>
                                  )
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
                                            <DatePickerTableCellTrigger>
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
                              <Index each={api().weekDays}>
                                {(weekDay) => {
                                  return (
                                    <DatePickerTableHeader>
                                      {weekDay().short}
                                    </DatePickerTableHeader>
                                  )
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
                                          <DatePickerTableCell
                                            value={day()}
                                            visibleRange={offset().visibleRange}
                                          >
                                            <DatePickerTableCellTrigger>
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
                    </>
                  )
                }}
              </DatePickerContext>
            </DatePickerView>

            <DatePickerView view="month">
              <DatePickerContext>
                {(api) => {
                  return (
                    <>
                      <DatePickerViewControl>
                        <DatePickerPrevTrigger />
                        <DatePickerViewTrigger>
                          <DatePickerRangeText />
                        </DatePickerViewTrigger>
                        <DatePickerNextTrigger />
                      </DatePickerViewControl>
                      <DatePickerTable>
                        <DatePickerTableBody>
                          <Index
                            each={api().getMonthsGrid({
                              columns: 4,
                              format: 'short',
                            })}
                          >
                            {(months) => {
                              return (
                                <DatePickerTableRow>
                                  <Index each={months()}>
                                    {(month) => {
                                      return (
                                        <DatePickerTableCell
                                          value={month().value}
                                        >
                                          <DatePickerTableCellTrigger>
                                            {month().label}
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

            <DatePickerView view="year">
              <DatePickerContext>
                {(api) => {
                  return (
                    <>
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
                                        <DatePickerTableCell
                                          value={year().value}
                                        >
                                          <DatePickerTableCellTrigger>
                                            {year().label}
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
          </DatePickerContent>
        </DatePickerPositioner>
      </Portal>
    </DatePicker>
  )
}
