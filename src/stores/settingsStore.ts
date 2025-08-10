// store.ts
import {endOfWeek, startOfWeek, subWeeks} from 'date-fns'
import {createStore} from 'solid-js/store'

interface SettingsState {
  fromDate: Date
  toDate: Date
  batchSize: number
}

export const [state, setState] = createStore<SettingsState>({
  fromDate: startOfWeek(subWeeks(new Date(), 1), {weekStartsOn: 1}),
  toDate: endOfWeek(subWeeks(new Date(), 1), {weekStartsOn: 1}),
  batchSize: 100,
})
