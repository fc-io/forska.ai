import {type JSX, Show} from 'solid-js'

import {Slider, SliderFill, SliderLabel, SliderThumb, SliderTrack, SliderValueLabel} from '../../ui/slider'
import {DateRangePicker} from './subheaderSettingsPanel/subheaderSettingsPanelDateRangePicker'

interface SettingsPanelProps {
  isOpen: boolean
  onClose: () => void
  numberOfRequests: number

  setNumberOfRequests: (count: number) => void
  fromDate: Date

  setFromDate: (date: Date) => void
  toDate: Date

  setToDate: (date: Date) => void
}

const SettingsPanel = (props: SettingsPanelProps): JSX.Element => {
  return (
    <Show when={props.isOpen}>
      <div class="mt-4 border border-gray-200 rounded-lg bg-gray-50 overflow-hidden transition-all duration-200">
        <div class="flex p-4">
          <div class="space-y-4">
            <p class="text-xs text-gray-500 mt-1">The date range affects both harvest and agent runs.</p>
            <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
              <DateRangePicker
                defaultStart={props.fromDate}
                defaultEnd={props.toDate}
                onValueChange={([start, end]) => {
                  props.setFromDate(start)
                  props.setToDate(end)
                }}
              />
            </div>
            <div>
              {/* <label class="block text-sm font-medium text-gray-700 mb-2">
                Agent Batch size
              </label> */}
              <div class="flex items-center space-x-2">
                <Slider
                  minValue={10}
                  maxValue={500}
                  defaultValue={[props.numberOfRequests]}
                  getValueLabel={(params) => {
                    return `${params.values[0]}`
                  }}
                  onChange={(details) => {
                    const values = Array.from(details.values())
                    if (values[0] !== undefined) {
                      props.setNumberOfRequests(values[0])
                    }
                  }}
                  class="w-[300px] space-y-3"
                >
                  <div class="flex w-full justify-between">
                    <SliderLabel>Batch size</SliderLabel>
                    <SliderValueLabel />
                  </div>
                  <SliderTrack>
                    <SliderFill />
                    <SliderThumb />
                  </SliderTrack>
                </Slider>
              </div>
              <p class="text-xs text-gray-500 mt-1">Controls how many articles to send in each agent run</p>
            </div>
          </div>
        </div>
      </div>
    </Show>
  )
}

export {SettingsPanel, type SettingsPanelProps}
